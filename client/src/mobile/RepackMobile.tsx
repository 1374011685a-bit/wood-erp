import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  createRepack,
  deleteRepack,
  fetchBaleDetail,
  fetchBales,
  fetchDict,
  fetchRepackList,
  isBaleNoTakenError,
  type BaleRow,
  type DictAll,
  type RepackBale,
  type RepackLine,
  type RepackRow,
} from '../api'
import { seesMoney } from '../permissions'
import { useRole } from '../hooks/useRole'
import { formatAmount, formatCubic, roundTo, todayISO, toNumber } from '../utils/num'
import { tapHeavy, tapLight, tapMedium } from '../utils/haptics'
import { useKeyboardScroll } from '../hooks/useKeyboardScroll'
import { goBack } from './nav'
import SuccessToast from '../components/SuccessToast'
import { useMobileFormKeyboard } from './useMobileFormKeyboard'
import {
  MobileCard,
  MobileDatePicker,
  MobileEmpty,
  MobileInput,
  MobileList,
  MobileListItem,
  MobileModal,
  MobileSearchBar,
  MobileSheet,
  MobileSkeleton,
  MobileToastHost,
  MobileTopbarActions,
  MobileTopbarButton,
  useAutoDismiss,
  type MobileToastItem,
} from './components'
import { useMobileNavigate } from './useMobileNavigate'

const PAGE_SIZE = 20
const AFTER_BLANK_ROWS = 3

type AfterRow = {
  key: number
  baleNo: string
  fromAction?: 'split' | 'copy'
  srcBaleId?: number
  brand: string
  species: string
  grade: string
  thickness: string
  width: string
  length: string
  pieces: string
  unitPrice: string
}

type ConfirmState =
  | { kind: 'discard'; missing: number }
  | { kind: 'split'; count: number; force: boolean }
  | null

let rowSeq = 0

const createRow = (): AfterRow => ({
  key: (rowSeq += 1),
  baleNo: '',
  brand: '',
  species: '',
  grade: '',
  thickness: '',
  width: '',
  length: '',
  pieces: '',
  unitPrice: '',
})

const blankRows = () => Array.from({ length: AFTER_BLANK_ROWS }, () => createRow())

const rowFromLine = (line: RepackLine): AfterRow => ({
  key: (rowSeq += 1),
  baleNo: '',
  brand: line.brand ?? '',
  species: line.species ?? '',
  grade: line.grade ?? '',
  thickness: String(line.thickness ?? ''),
  width: String(line.width ?? ''),
  length: line.length_text ?? String(line.length ?? ''),
  pieces: line.pieces_text ?? String(line.pieces ?? ''),
  unitPrice: '',
})

const slashSegments = (text: string) =>
  String(text ?? '')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part !== '')

const toMetersText = (raw: string) => {
  const num = Number(String(raw ?? '').trim())
  if (!Number.isFinite(num) || num <= 0) return NaN
  return num > 20 ? num / 1000 : num
}

const rowSpecs = (row: AfterRow) => {
  const lengths = slashSegments(row.length)
  const pieces = slashSegments(row.pieces)
  if (lengths.length === 0 || lengths.length !== pieces.length) return []
  return lengths.map((length, index) => ({
    length: toMetersText(length),
    pieces: Number(pieces[index]),
  }))
}

const rowCubic = (row: AfterRow) =>
  roundTo(
    rowSpecs(row).reduce((sum, spec) => {
      if (!Number.isFinite(spec.length)) return sum
      return (
        sum +
        (toNumber(row.thickness) * toNumber(row.width) * spec.length * spec.pieces) / 1_000_000
      )
    }, 0),
    4,
  )

const groupRows = (rows: AfterRow[]) => {
  const groups: Array<{ baleNo: string; rows: AfterRow[] }> = []
  const byBaleNo = new Map<string, AfterRow[]>()
  for (const row of rows) {
    const no = row.baleNo.trim()
    if (!no) {
      groups.push({ baleNo: '', rows: [row] })
      continue
    }
    const hit = byBaleNo.get(no)
    if (hit) {
      hit.push(row)
      continue
    }
    const bucket = [row]
    byBaleNo.set(no, bucket)
    groups.push({ baleNo: no, rows: bucket })
  }
  return groups
}

const lineDescription = (line: RepackLine) =>
  [
    line.brand,
    line.species,
    line.grade ? `等级 ${line.grade}` : '',
    `${line.thickness}×${line.width}×${line.length_text ?? line.length}`,
    `${line.pieces_text ?? line.pieces} 片`,
  ]
    .filter(Boolean)
    .join(' · ')

function LineField({
  label,
  value,
  list,
  onChange,
  inputMode = 'numeric',
}: {
  label: string
  value: string
  list?: string
  onChange: (next: string) => void
  inputMode?: 'text' | 'numeric'
}) {
  return (
    <label className="m-line-field">
      <span className="m-line-label">{label}</span>
      <input
        className="m-line-input"
        value={value}
        list={list}
        inputMode={inputMode}
        enterKeyHint="next"
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}

export default function RepackMobile() {
  const navigate = useMobileNavigate()
  const [searchParams] = useSearchParams()
  const formOpen = searchParams.get('mode') === 'new'
  const money = seesMoney(useRole())
  useKeyboardScroll(formOpen)
  useMobileFormKeyboard(formOpen)

  const [keyword, setKeyword] = useState('')
  const [debounced, setDebounced] = useState('')
  const [listRows, setListRows] = useState<RepackRow[]>([])
  const [total, setTotal] = useState(0)
  const [listLoading, setListLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const [detail, setDetail] = useState<RepackRow | null>(null)
  const [undoTarget, setUndoTarget] = useState<RepackRow | null>(null)
  const [undoing, setUndoing] = useState(false)
  const [toast, setToast] = useState<MobileToastItem | null>(null)
  const [success, setSuccess] = useState<{
    title: string
    subtitle: string
    toList: boolean
  } | null>(null)
  useAutoDismiss(toast, () => setToast(null))

  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerKeyword, setPickerKeyword] = useState('')
  const [pickerDebounced, setPickerDebounced] = useState('')
  const [pickerRows, setPickerRows] = useState<BaleRow[]>([])
  const [pickerPicked, setPickerPicked] = useState<Record<number, BaleRow>>({})
  const [pickerLoading, setPickerLoading] = useState(false)
  const [addingSources, setAddingSources] = useState(false)
  const [pickedBales, setPickedBales] = useState<RepackBale[]>([])
  const [rows, setRows] = useState<AfterRow[]>(() => blankRows())
  const [repackDate, setRepackDate] = useState(todayISO())
  const [summary, setSummary] = useState('')
  const [remark, setRemark] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmState>(null)
  const [continueAfterConfirm, setContinueAfterConfirm] = useState(false)
  const [dict, setDict] = useState<DictAll>({ species: [], grade: [] })
  const [brandOptions, setBrandOptions] = useState<string[]>([])

  useEffect(() => {
    void fetchDict().then(setDict).catch(() => undefined)
    void fetchBales({ limit: 200 })
      .then((page) => {
        const brands = new Set<string>()
        for (const row of page.rows) {
          for (const brand of String(row.brand ?? '').split('/')) {
            const name = brand.trim()
            if (name) brands.add(name)
          }
        }
        setBrandOptions([...brands])
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(keyword.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [keyword])

  const loadList = useCallback(async (offset: number, append: boolean) => {
    if (append) setLoadingMore(true)
    else setListLoading(true)
    try {
      const result = await fetchRepackList({
        keyword: debounced || undefined,
        limit: PAGE_SIZE,
        offset,
      })
      setListRows((prev) => (append ? [...prev, ...result.rows] : result.rows))
      setTotal(result.total)
    } catch (err) {
      setToast({
        id: `list-${Date.now()}`,
        message: err instanceof Error ? err.message : '加载改包记录失败',
      })
    } finally {
      setListLoading(false)
      setLoadingMore(false)
    }
  }, [debounced])

  useEffect(() => {
    void loadList(0, false)
  }, [loadList, reloadToken])

  useEffect(() => {
    const timer = window.setTimeout(() => setPickerDebounced(pickerKeyword.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [pickerKeyword])

  useEffect(() => {
    if (!pickerOpen) return
    let cancelled = false
    setPickerLoading(true)
    fetchBales({ status: 'in_stock', keyword: pickerDebounced || undefined, limit: 50 })
      .then((result) => {
        if (!cancelled) setPickerRows(result.rows)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setToast({
            id: `pick-${Date.now()}`,
            message: err instanceof Error ? err.message : '加载在库包失败',
          })
        }
      })
      .finally(() => {
        if (!cancelled) setPickerLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [pickerOpen, pickerDebounced])

  const beforeCubic = useMemo(
    () =>
      roundTo(
        pickedBales.reduce(
          (sum, bale) => sum + bale.items.reduce((part, line) => part + (line.cubic ?? 0), 0),
          0,
        ),
        4,
      ),
    [pickedBales],
  )

  const afterCubic = useMemo(
    () => roundTo(rows.reduce((sum, row) => sum + rowCubic(row), 0), 4),
    [rows],
  )

  const filledRows = useMemo(() => rows.filter((row) => row.species.trim()), [rows])
  const willDiscard = roundTo(beforeCubic - afterCubic, 4)
  const lossCubic = roundTo(afterCubic - beforeCubic, 4)
  const isMixedBale = pickedBales.some((bale) => bale.items.length > 1)

  const openForm = () => {
    tapLight()
    setPickedBales([])
    setRows(blankRows())
    setSummary('')
    setRemark('')
    setPickerPicked({})
    setPickerKeyword('')
    navigate('/repack?mode=new')
  }

  const togglePicker = (row: BaleRow) => {
    setPickerPicked((prev) => {
      const next = { ...prev }
      if (next[row.id]) delete next[row.id]
      else next[row.id] = row
      return next
    })
  }

  const addPickedSources = async () => {
    const selected = Object.values(pickerPicked).filter(
      (row) => !pickedBales.some((bale) => bale.id === row.id),
    )
    if (selected.length === 0) return
    setAddingSources(true)
    try {
      const details = await Promise.all(
        selected.map((row) => fetchBaleDetail(row.id).then((full) => ({ row, full }))),
      )
      const added: RepackBale[] = details.map(({ row, full }) => ({
        id: full.id,
        bale_no: full.bale_no,
        barcode: full.barcode,
        cubic: full.cubic,
        pieces: full.pieces,
        bl_no: full.bl_no || row.bl_no,
        contract_no: row.contract_no,
        items: full.items.map((line) => ({
          ...line,
          src_bale_id: full.id,
          src_bale_no: full.bale_no,
          length_text: String(line.length),
          pieces_text: String(line.pieces),
        })),
      }))
      setPickedBales((prev) => [...prev, ...added])
      setRows(blankRows())
      setPickerOpen(false)
      setPickerPicked({})
      setPickerKeyword('')
    } catch (err) {
      setToast({
        id: `detail-${Date.now()}`,
        message: err instanceof Error ? err.message : '读取源包详情失败',
      })
    } finally {
      setAddingSources(false)
    }
  }

  const removeSource = (id: number) => {
    tapHeavy()
    setPickedBales((prev) => prev.filter((bale) => bale.id !== id))
    setRows(blankRows())
  }

  const updateRow = (key: number, field: keyof AfterRow, value: string) => {
    setRows((prev) =>
      prev.map((row) => (row.key === key ? { ...row, [field]: value } : row)),
    )
  }

  const addRow = () => {
    tapLight()
    setRows((prev) => [...prev, createRow()])
  }

  const removeRow = (key: number) => {
    tapHeavy()
    setRows((prev) => (prev.length > 1 ? prev.filter((row) => row.key !== key) : prev))
  }

  const copyBefore = () => {
    const next = pickedBales
      .filter((bale) => bale.items.length > 0)
      .map((bale) => {
        const first = bale.items[0]
        return {
          ...createRow(),
          fromAction: 'copy' as const,
          baleNo: bale.bale_no ?? '',
          srcBaleId: bale.id,
          brand: first.brand ?? '',
          species: first.species ?? '',
          grade: first.grade ?? '',
          thickness: String(first.thickness ?? ''),
          width: String(first.width ?? ''),
          length: bale.items.map((line) => line.length).join('/'),
          pieces: bale.items.map((line) => line.pieces).join('/'),
        }
      })
    if (next.length > 0) setRows(next)
  }

  /**
   * 与桌面端 pages/Repack.tsx 的 splitByLength 保持同一规则：
   * 每个源包的每个规格行各成一行，包号留空，srcBaleId 指回源包。
   */
  const splitByLength = () => {
    tapMedium()
    const next = pickedBales.flatMap((bale) =>
      bale.items.map((line) => ({
        ...rowFromLine(line),
        fromAction: 'split' as const,
        baleNo: '',
        srcBaleId: bale.id,
      })),
    )
    if (next.length > 0) setRows(next)
  }

  const needsSplitConfirm = (list: AfterRow[]) =>
    list.length > 1 &&
    list.every((row) => !row.baleNo.trim()) &&
    !list.some((row) => row.fromAction === 'split')

  const validateRows = (list: AfterRow[]) => {
    const problems: string[] = []
    list.forEach((row, index) => {
      const reasons: string[] = []
      if (!row.species.trim()) reasons.push('品名不能为空')
      if (!(toNumber(row.thickness) > 0)) reasons.push('厚度要大于 0')
      if (slashSegments(row.thickness).length > 1) reasons.push('厚度只能填一个数')
      if (!(toNumber(row.width) > 0)) reasons.push('宽度要大于 0')
      if (slashSegments(row.width).length > 1) reasons.push('宽度只能填一个数')

      const lengths = slashSegments(row.length)
      const pieces = slashSegments(row.pieces)
      if (lengths.length === 0) {
        reasons.push('长度要大于 0')
      } else if (lengths.length !== pieces.length) {
        reasons.push('长度和片数的段数要一样多')
      } else {
        rowSpecs(row).forEach((spec, segment) => {
          const at = lengths.length > 1 ? `第 ${segment + 1} 段` : ''
          if (!(spec.length > 0 && spec.length <= 20)) reasons.push(`${at}长度要在 0~20m`)
          if (!(Number.isInteger(spec.pieces) && spec.pieces > 0)) {
            reasons.push(`${at}片数要是大于 0 的整数`)
          }
        })
      }
      if (reasons.length > 0) problems.push(`第 ${index + 1} 行：${reasons.join('；')}`)
    })
    return problems
  }

  const submitRepack = async (force = false, continueAfter = false) => {
    const filled = rows.filter((row) => row.species.trim())
    setSaving(true)
    try {
      const result = await createRepack({
        repack_date: repackDate,
        bale_ids: pickedBales.map((bale) => bale.id),
        summary: summary.trim(),
        remark: remark.trim(),
        ...(force ? { force: true } : {}),
        groups: groupRows(filled).map((group) => ({
          bale_no: group.baleNo,
          items: group.rows.map((row) => ({
            brand: row.brand.trim(),
            species: row.species.trim(),
            grade: row.grade.trim(),
            thickness: toNumber(row.thickness),
            width: toNumber(row.width),
            length: row.length.trim(),
            pieces: row.pieces.trim(),
            unit_price: toNumber(row.unitPrice),
            ...(row.srcBaleId ? { srcBaleId: row.srcBaleId } : {}),
          })),
        })),
      })
      setConfirm(null)
      setReloadToken((value) => value + 1)
      const sourceNames = pickedBales.map((bale) => bale.bale_no || bale.barcode).join('、')
      const operation =
        pickedBales.length > 1 ? '合并' : result.bale_count > 1 ? '拆分' : '调整'
      setPickedBales([])
      setRows(blankRows())
      setSummary('')
      setRemark('')
      setSuccess({
        title: '已改包',
        subtitle: `原包 ${sourceNames || '—'} 已完成${operation}`,
        toList: !continueAfter,
      })
    } catch (err) {
      setToast({
        id: `save-${Date.now()}`,
        message: err instanceof Error ? err.message : '保存改包失败',
      })
    } finally {
      setSaving(false)
    }
  }

  const handleSave = (continueAfter: boolean) => {
    tapMedium()
    if (pickedBales.length === 0) {
      setToast({ id: `v-${Date.now()}`, message: '请先选择至少一个源包' })
      return
    }
    const filled = rows.filter((row) => row.species.trim())
    if (filled.length === 0) {
      setToast({ id: `v-${Date.now()}`, message: '改包后至少要有一行规格' })
      return
    }
    const problems = validateRows(filled)
    if (problems.length > 0) {
      setToast({ id: `v-${Date.now()}`, message: problems[0] })
      const match = /^第 (\d+) 行/.exec(problems[0])
      const bad = match ? filled[Number(match[1]) - 1] : null
      if (bad) {
        const target = document.querySelector<HTMLElement>(`[data-m-row="${bad.key}"]`)
        target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
        if (target) {
          target.classList.remove('is-error-flash')
          void target.offsetWidth
          target.classList.add('is-error-flash')
          window.setTimeout(() => target.classList.remove('is-error-flash'), 1050)
        }
      }
      return
    }

    // 红线：只比较改前/改后总立方，不做任何逐行规格匹配。
    if (willDiscard > 0.0001) {
      setContinueAfterConfirm(continueAfter)
      setConfirm({ kind: 'discard', missing: willDiscard })
      return
    }
    if (needsSplitConfirm(filled)) {
      setContinueAfterConfirm(continueAfter)
      setConfirm({ kind: 'split', count: filled.length, force: false })
      return
    }
    void submitRepack(false, continueAfter)
  }

  const confirmSave = () => {
    if (!confirm) return
    if (confirm.kind === 'discard') {
      void submitRepack(true, continueAfterConfirm)
      return
    }
    void submitRepack(confirm.force, continueAfterConfirm)
  }

  const confirmUndo = async () => {
    if (!undoTarget) return
    setUndoing(true)
    try {
      await deleteRepack(undoTarget.id)
      setToast({
        id: `undo-${Date.now()}`,
        message: `已撤销改包 ${undoTarget.repack_no}，库存已恢复`,
      })
      setUndoTarget(null)
      setDetail(null)
      setReloadToken((value) => value + 1)
    } catch (err) {
      setToast({
        id: `undo-${Date.now()}`,
        message: isBaleNoTakenError(err)
          ? `${err.message}，请先在桌面端处理包号冲突`
          : err instanceof Error
            ? err.message
            : '撤销改包失败',
      })
    } finally {
      setUndoing(false)
    }
  }

  const renderLines = (items: RepackLine[]) => (
    <div className="m-detail-lines">
      {items.map((line, index) => (
        <div className="m-detail-line" key={`${line.src_bale_id ?? ''}-${index}`}>
          <span>{lineDescription(line)}</span>
          <b>{formatCubic(line.cubic ?? 0)} m³</b>
        </div>
      ))}
    </div>
  )

  if (formOpen) {
    return (
      <div className="m-stack repack-form" style={{ paddingBottom: 56 }}>
        <datalist id="m-repack-species">
          {dict.species.map((item) => (
            <option value={item.name} key={item.id} />
          ))}
        </datalist>
        <datalist id="m-repack-grade">
          {dict.grade.map((item) => (
            <option value={item.name} key={item.id} />
          ))}
        </datalist>
        <datalist id="m-repack-brand">
          {brandOptions.map((name) => (
            <option value={name} key={name} />
          ))}
        </datalist>
        <MobileCard title="改包信息">
          <MobileDatePicker label="改包日期" value={repackDate} onChange={setRepackDate} />
          <MobileInput label="摘要" value={summary} onChange={setSummary} />
          <MobileInput label="备注" value={remark} onChange={setRemark} />
        </MobileCard>

        <MobileCard title="改包前" hint={`${pickedBales.length} 个源包`}>
          <button
            type="button"
            className="m-btn m-btn-primary"
            onClick={() => {
              tapLight()
              setPickerPicked({})
              setPickerKeyword('')
              setPickerOpen(true)
            }}
          >
            选择源包
          </button>
          {pickedBales.length === 0 ? (
            <MobileEmpty text="还没有源包，先选择要从哪些包开始改" />
          ) : (
            <div className="m-source-list">
              {pickedBales.map((bale) => (
                <div className="m-source-card" key={bale.id}>
                  <div className="m-source-head">
                    <div>
                      <b>{bale.bale_no || bale.barcode}</b>
                      <span>提单 {bale.bl_no || '—'}</span>
                    </div>
                    <button
                      type="button"
                      className="m-icon-btn"
                      aria-label="移除这个源包"
                      onClick={() => removeSource(bale.id)}
                    >
                      ✕
                    </button>
                  </div>
                  {bale.items.map((line, index) => (
                    <div className="m-source-line" key={`${line.id ?? index}`}>
                      <span>{lineDescription(line)}</span>
                      <b>{formatCubic(line.cubic ?? 0)} m³</b>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </MobileCard>

        <div className={lossCubic < 0 ? 'm-loss-card is-bad' : 'm-loss-card'}>
          <span>改前 {formatCubic(beforeCubic)} m³</span>
          <span>改后 {formatCubic(afterCubic)} m³</span>
          <strong>
            {lossCubic < 0 ? '⚠ ' : ''}
            损耗 {formatCubic(lossCubic)} m³
          </strong>
        </div>

        <MobileCard title="改包后" hint={`${filledRows.length} 行`}>
          <div className="m-toolbar-row">
            <button
              type="button"
              className="m-btn m-btn-ghost m-btn-compact"
              disabled={pickedBales.length === 0}
              onClick={copyBefore}
            >
              复制改包前
            </button>
            <button
              type="button"
              className="m-btn m-btn-ghost m-btn-compact"
              disabled={!isMixedBale}
              onClick={splitByLength}
            >
              一键拆包
            </button>
            <button type="button" className="m-btn m-btn-ghost m-btn-compact" onClick={addRow}>
              + 加一行
            </button>
          </div>

          {rows.map((row, index) => (
            <div className="m-line m-repack-line" key={row.key} data-m-row={row.key}>
              <div className="m-line-editor-head">
                <span>
                  第 {index + 1} 行
                  {row.srcBaleId
                    ? ` · 旧包 ${pickedBales.find((bale) => bale.id === row.srcBaleId)?.bale_no || '—'}`
                    : ''}
                </span>
                <b>{formatCubic(rowCubic(row))} m³</b>
                <button
                  type="button"
                  className="m-icon-btn"
                  aria-label={`删除第 ${index + 1} 行`}
                  disabled={rows.length <= 1}
                  onClick={() => removeRow(row.key)}
                >
                  ✕
                </button>
              </div>
              <div className="m-line-grid m-line-grid-2">
                <LineField
                  label="新包号"
                  value={row.baleNo}
                  inputMode="text"
                  onChange={(value) => updateRow(row.key, 'baleNo', value)}
                />
                <LineField
                  label="品牌"
                  value={row.brand}
                  list="m-repack-brand"
                  inputMode="text"
                  onChange={(value) => updateRow(row.key, 'brand', value)}
                />
              </div>
              <div className="m-line-grid m-line-grid-1">
                <LineField
                  label="品名 *"
                  value={row.species}
                  list="m-repack-species"
                  inputMode="text"
                  onChange={(value) => updateRow(row.key, 'species', value)}
                />
              </div>
              <div className="m-line-grid m-line-grid-4">
                <LineField
                  label="等级"
                  value={row.grade}
                  list="m-repack-grade"
                  inputMode="text"
                  onChange={(value) => updateRow(row.key, 'grade', value)}
                />
                <LineField
                  label="厚"
                  value={row.thickness}
                  onChange={(value) => updateRow(row.key, 'thickness', value)}
                />
                <LineField
                  label="宽"
                  value={row.width}
                  onChange={(value) => updateRow(row.key, 'width', value)}
                />
                <LineField
                  label="长"
                  value={row.length}
                  onChange={(value) => updateRow(row.key, 'length', value)}
                />
              </div>
              <div className={money ? 'm-line-grid m-line-grid-2' : 'm-line-grid m-line-grid-1'}>
                <LineField
                  label="片数 *"
                  value={row.pieces}
                  onChange={(value) => updateRow(row.key, 'pieces', value)}
                />
                {money ? (
                  <LineField
                    label="单价（选填）"
                    value={row.unitPrice}
                    onChange={(value) => updateRow(row.key, 'unitPrice', value)}
                  />
                ) : null}
              </div>
            </div>
          ))}
        </MobileCard>

        <div className="m-actionbar m-actionbar-3 m-actionbar-full">
          <button
            type="button"
            className="m-btn m-btn-primary"
            disabled={saving}
            onClick={() => handleSave(false)}
          >
            {saving ? '保存中…' : '保存'}
          </button>
          <button
            type="button"
            className="m-btn m-btn-ghost"
            disabled={saving}
            onClick={() => handleSave(true)}
          >
            保存并继续
          </button>
          <button
            type="button"
            className="m-btn m-btn-ghost"
            onClick={() => goBack(navigate, '/repack')}
          >
            取消
          </button>
        </div>

        <MobileSheet
          open={pickerOpen}
          title="选择源包"
          onClose={() => {
            setPickerOpen(false)
            setPickerPicked({})
          }}
        >
          <MobileSearchBar
            value={pickerKeyword}
            placeholder="包号 / 提单号 / 品名"
            onChange={setPickerKeyword}
          />
          <p className="m-picker-count">
            共 {pickerRows.length} 包在库
            {Object.keys(pickerPicked).length > 0
              ? ` · 已选 ${Object.keys(pickerPicked).length}`
              : ''}
          </p>
          <div className="m-picker-scroll">
            {pickerLoading ? (
              <MobileSkeleton cards={2} />
            ) : pickerRows.length === 0 ? (
              <MobileEmpty text="没有找到可改包的在库包" />
            ) : (
              <div className="m-rows">
                {pickerRows.map((bale) => {
                  const checked = Boolean(pickerPicked[bale.id])
                  return (
                    <button
                      type="button"
                      className={checked ? 'm-row-check is-on' : 'm-row-check'}
                      key={bale.id}
                      onClick={() => togglePicker(bale)}
                    >
                      <span className="m-check-box" aria-hidden="true">
                        ✓
                      </span>
                      <span className="m-item-main">
                        <span className="m-item-title">
                          {bale.bale_no || bale.barcode} · 提单 {bale.bl_no || '—'}
                        </span>
                        <span className="m-item-sub">
                          {bale.species} {bale.grade || ''} ·{' '}
                          {bale.pieces_text || bale.pieces} 片 · {formatCubic(bale.cubic)} m³
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
          <div className="m-sheet-actions">
            <button
              type="button"
              className="m-btn m-btn-primary"
              disabled={Object.keys(pickerPicked).length === 0 || addingSources}
              onClick={() => void addPickedSources()}
            >
              {addingSources ? '读取中…' : `加入本次改包（${Object.keys(pickerPicked).length}）`}
            </button>
            <button
              type="button"
              className="m-btn m-btn-ghost"
              onClick={() => {
                setPickerOpen(false)
                setPickerPicked({})
              }}
            >
              取消
            </button>
          </div>
        </MobileSheet>

        <MobileModal
          open={Boolean(confirm)}
          title={confirm?.kind === 'discard' ? '改包后总量变少了' : '确认拆成多个包'}
          message={
            confirm?.kind === 'discard'
              ? `改后总量比改前少 ${formatCubic(confirm.missing)} m³。确认后会按当前明细保存。`
              : confirm?.kind === 'split'
                ? `新包号都为空，本次会把 ${confirm.count} 行拆成 ${confirm.count} 个独立包。`
                : undefined
          }
          confirmLabel={confirm?.kind === 'discard' ? '确认丢货并保存' : '确认拆包'}
          danger={confirm?.kind === 'discard'}
          onConfirm={confirmSave}
          onClose={() => setConfirm(null)}
        />

        <MobileToastHost items={[toast]} />
        <SuccessToast
          open={Boolean(success)}
          title={success?.title ?? ''}
          subtitle={success?.subtitle ?? ''}
          onDone={() => {
            const goList = Boolean(success?.toList)
            setSuccess(null)
            if (goList) navigate('/repack', { replace: true })
          }}
        />
      </div>
    )
  }

  return (
    <div className="m-stack">
      <MobileTopbarActions>
        <MobileTopbarButton label="＋" onClick={openForm} />
      </MobileTopbarActions>

      <MobileSearchBar
        value={keyword}
        placeholder="搜改包单号 / 包号"
        onChange={setKeyword}
      />

      {listLoading ? (
        <MobileSkeleton cards={3} />
      ) : listRows.length === 0 ? (
        <MobileEmpty
          text={debounced ? '没有符合条件的改包记录' : '还没有改包记录'}
          actionLabel="新增改包"
          onAction={openForm}
        />
      ) : (
        <>
          <MobileList>
            {listRows.map((row) => (
              <MobileListItem
                key={row.id}
                dense
                title={row.repack_no}
                sub={`${row.repack_date} · ${row.before_cubic.toFixed(4)} → ${row.after_cubic.toFixed(4)} m³ · ${row.bale_count} 包`}
                trail={
                  <span className={row.loss_cubic < 0 ? 'm-loss-text is-bad' : 'm-loss-text'}>
                    {formatCubic(row.loss_cubic)} m³
                  </span>
                }
                onClick={() => {
                  tapLight()
                  setDetail(row)
                }}
              />
            ))}
          </MobileList>
          {listRows.length < total ? (
            <button
              type="button"
              className="m-loadmore"
              disabled={loadingMore}
              onClick={() => void loadList(listRows.length, true)}
            >
              {loadingMore ? '加载中…' : `加载更多（还有 ${total - listRows.length} 条）`}
            </button>
          ) : (
            <p className="m-list-end">共 {total} 条改包记录</p>
          )}
        </>
      )}

      <MobileSheet
        open={Boolean(detail)}
        title={detail?.repack_no ?? '改包详情'}
        onClose={() => setDetail(null)}
      >
        {detail ? (
          <>
            <div className="m-rows">
              {[
                ['改包日期', detail.repack_date],
                ['源包', detail.source_bale_nos.join('、') || detail.bale_no || '—'],
                ['提单', detail.bl_no || '—'],
                ['改后包数', `${detail.bale_count} 包`],
                ['改前方数', `${formatCubic(detail.before_cubic)} m³`, true],
                ['改后方数', `${formatCubic(detail.after_cubic)} m³`, true],
                ['损耗', `${formatCubic(detail.loss_cubic)} m³`, true],
                ...(money
                  ? [
                      ['改前金额', `${formatAmount(detail.before_amount)} 元`, true],
                      ['改后金额', `${formatAmount(detail.after_amount)} 元`, true],
                    ]
                  : []),
                ['备注', detail.remark || detail.summary || '—'],
              ].map(([label, value, numeric]) => (
                <div className="m-row" key={String(label)}>
                  <span className="m-row-label">{String(label)}</span>
                  <span className={numeric ? 'm-row-value is-num' : 'm-row-value'}>
                    {String(value)}
                  </span>
                </div>
              ))}
            </div>

            <h3 className="m-detail-title">改包前</h3>
            {renderLines(detail.before_items)}
            <h3 className="m-detail-title">改包后</h3>
            {detail.after_bales?.length ? (
              detail.after_bales.map((bale) => (
                <div className="m-detail-group" key={`${bale.bale_no}-${bale.barcode}`}>
                  <b>{bale.bale_no || bale.barcode || '未填包号'}</b>
                  {renderLines(bale.items)}
                </div>
              ))
            ) : (
              renderLines(detail.after_items)
            )}

            <div className="m-sheet-actions">
              <button
                type="button"
                className="m-btn m-btn-danger"
                onClick={() => {
                  tapHeavy()
                  setUndoTarget(detail)
                }}
              >
                撤销改包
              </button>
              <button type="button" className="m-btn m-btn-ghost" onClick={() => setDetail(null)}>
                关闭
              </button>
            </div>
          </>
        ) : null}
      </MobileSheet>

      <MobileModal
        open={Boolean(undoTarget)}
        title="撤销这条改包？"
        message={
          undoTarget
            ? `${undoTarget.repack_no} 会删除改包后生成的包，并恢复改包前的源包和库存。`
            : undefined
        }
        confirmLabel={undoing ? '处理中…' : '确认撤销'}
        danger
        onConfirm={() => void confirmUndo()}
        onClose={() => {
          if (!undoing) setUndoTarget(null)
        }}
      />

      <MobileToastHost items={[toast]} />
    </div>
  )
}
