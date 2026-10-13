import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createRepack,
  fetchBaleDetail,
  fetchBales,
  deleteRepack,
  fetchRepackBales,
  fetchRepackList,
  fetchDict,
  type BaleRow,
  type RepackBale,
  type RepackLine,
  type RepackRow,
  type RepackSums,
} from '../api'
import { EmptyState, Loading, PageHead, Pager, ToastHost } from '../components/Ui'
import { toNumber, roundTo, formatCubic, formatAmount, todayISO } from '../utils/num'

const PAGE_SIZE = 20

/** 改包后的一行（一包里的一个规格） */
type AfterRow = {
  key: number
  /** 品牌（选填）：只记不参与匹配 */
  brand: string
  species: string
  grade: string
  thickness: string
  width: string
  length: string
  pieces: string
  /** 留空 = 按改前成本自动算 */
  unitPrice: string
}

let rowSeq = 0
const createRow = (): AfterRow => ({
  key: (rowSeq += 1),
  brand: '',
  species: '',
  grade: '',
  thickness: '',
  width: '',
  length: '',
  pieces: '',
  unitPrice: '',
})

const rowFromLine = (line: RepackLine): AfterRow => ({
  key: (rowSeq += 1),
  brand: line.brand ?? '',
  species: line.species ?? '',
  grade: line.grade ?? '',
  thickness: String(line.thickness ?? ''),
  width: String(line.width ?? ''),
  length: String(line.length ?? ''),
  pieces: String(line.pieces ?? ''),
  unitPrice: '',
})

/** 一行的立方：厚 × 宽 × 长 × 片数 ÷ 1,000,000（一包就是一件） */
const rowCubic = (row: AfterRow) =>
  roundTo(
    (toNumber(row.thickness) *
      toNumber(row.width) *
      toNumber(row.length) *
      toNumber(row.pieces)) /
      1000000,
    4,
  )

const lineCubic = (line: RepackLine) => roundTo(line.cubic ?? 0, 4)

/** 改前这一行匹配到多个成本价时，用户必须选一个（见 beforePrices） */
const isPriceAmbiguous = (line: RepackLine) => Boolean(line.price_ambiguous)

export default function Repack() {
  const [bales, setBales] = useState<RepackBale[]>([])
  const [baleId, setBaleId] = useState(0)
  // 选货弹窗
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQuery, setPickerQuery] = useState({
    keyword: '',
    warehouse: '',
    status: 'in_stock' as '' | 'in_stock' | 'shipped',
    date_from: '',
    date_to: '',
  })
  const [pickerRows, setPickerRows] = useState<BaleRow[]>([])
  const [pickerTotal, setPickerTotal] = useState(0)
  const [pickerOffset, setPickerOffset] = useState(0)
  const [pickerLoading, setPickerLoading] = useState(false)
  const [rows, setRows] = useState<AfterRow[]>(() => [createRow()])
  /**
   * 改前成本价：同一规格在入库明细里匹配到多个价时，必须让用户选一个
   * （键是包里的规格行 id）。没选的行不允许保存，绝不静默取第一条。
   */
  const [beforePrices, setBeforePrices] = useState<Record<number, string>>({})
  const [form, setForm] = useState({
    repackDate: todayISO(),
    summary: '',
    remark: '',
    blNo: '',
    contractNo: '',
  })
  const [saving, setSaving] = useState(false)
  // 默认进来看改包记录，点「新增改包」才进录入界面
  const [formOpen, setFormOpen] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [list, setList] = useState<RepackRow[]>([])
  const [sums, setSums] = useState<RepackSums | null>(null)
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [filters, setFilters] = useState({ date_to: '', species: '' })
  const [query, setQuery] = useState({ date_to: '', species: '' })
  const [loading, setLoading] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const [undoTarget, setUndoTarget] = useState<RepackRow | null>(null)
  const [dict, setDict] = useState<{ species: string[]; grade: string[] }>({
    species: [],
    grade: [],
  })

  const bale = useMemo(
    () => bales.find((item) => item.id === baleId) ?? null,
    [bales, baleId],
  )

  const loadBales = useCallback(async () => {
    try {
      setBales(await fetchRepackBales())
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载可改包的码单失败')
    }
  }, [])

  const loadList = useCallback(async (nextQuery: typeof query, nextOffset: number) => {
    setLoading(true)
    try {
      const page = await fetchRepackList({
        date_to: nextQuery.date_to || undefined,
        species: nextQuery.species.trim() || undefined,
        limit: PAGE_SIZE,
        offset: nextOffset,
      })
      setList(page.rows)
      setTotal(page.total)
      setSums(page.sums)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载改包记录失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadBales()
  }, [loadBales, reloadToken])

  useEffect(() => {
    void fetchDict()
      .then((data) =>
        setDict({
          species: data.species.map((item) => item.name),
          grade: data.grade.map((item) => item.name),
        }),
      )
      .catch(() => {
        // 拉不到就退化成手填
      })
  }, [])

  useEffect(() => {
    void loadList(query, offset)
  }, [loadList, query, offset, reloadToken])

  /**
   * 改前这一行的成本单价：
   * - 匹配到多个价的行 → 用用户在「改包前」里选的那个（没选就按 0，并且不允许保存）；
   * - 只有一种价 → 直接用；
   * - 匹配不到 → 0。
   */
  const beforePriceOf = (line: RepackLine) => {
    if (line.id !== undefined && isPriceAmbiguous(line)) {
      const picked = beforePrices[line.id]
      return picked === undefined || picked === '' ? 0 : toNumber(picked)
    }
    return line.unit_price ?? 0
  }

  /** 还有几行「匹配到多个成本价」但用户没选（没选就不让保存） */
  const ambiguousCount = (bale?.items ?? []).filter(
    (line) => line.id !== undefined && isPriceAmbiguous(line) && !beforePrices[line.id],
  ).length

  /** 改前总成本 = 每一行 立方 × 那一行的入库单价 */
  const beforeCubic = useMemo(
    () =>
      roundTo(
        (bale?.items ?? []).reduce((sum, line) => sum + lineCubic(line), 0),
        4,
      ),
    [bale],
  )
  const beforeAmount = useMemo(
    () =>
      roundTo(
        (bale?.items ?? []).reduce(
          (sum, line) => sum + lineCubic(line) * beforePriceOf(line),
          0,
        ),
        2,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bale, beforePrices],
  )

  const afterCubic = useMemo(
    () => roundTo(rows.reduce((sum, row) => sum + rowCubic(row), 0), 4),
    [rows],
  )

  /**
   * 改后成本单价：
   * - 用户填了单价 → 用他填的，不再随改前成本变；
   * - 没填 → 改前总成本 ÷ 改后总方数，改前成本一变它跟着变。
   */
  const pinned = rows.some((row) => toNumber(row.unitPrice) > 0)
  const derivedPrice = afterCubic > 0 ? roundTo(beforeAmount / afterCubic, 2) : 0
  const priceOf = (row: AfterRow) =>
    toNumber(row.unitPrice) > 0 ? toNumber(row.unitPrice) : derivedPrice
  const afterAmount = useMemo(
    () => roundTo(rows.reduce((sum, row) => sum + rowCubic(row) * priceOf(row), 0), 2),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, derivedPrice],
  )

  /** 选货弹窗里选中一包：拉它的规格明细填进表单 */
  const pickFromPicker = async (row: BaleRow) => {
    try {
      const full = await fetchBaleDetail(row.id)
      /**
       * 成本价候选只有 /api/repacks/bales 会返回（它有「匹配到多个价」的判断），
       * 这里按规格从已加载的列表里把候选并进来；找不到就当没有歧义。
       */
      const known = bales.find((item) => item.id === full.id)
      const merged = full.items.map((item) => {
        const same = known?.items.find(
          (line) =>
            line.species === item.species &&
            (line.grade ?? '') === (item.grade ?? '') &&
            line.thickness === item.thickness &&
            line.width === item.width &&
            line.length === item.length &&
            line.pieces === item.pieces,
        )
        return {
          id: item.id,
          brand: item.brand ?? '',
          species: item.species,
          grade: item.grade,
          thickness: item.thickness,
          width: item.width,
          length: item.length,
          pieces: item.pieces,
          cubic: item.cubic,
          unit_price: item.unit_price ?? 0,
          price_ambiguous: same?.price_ambiguous,
          price_candidates: same?.price_candidates,
        }
      })
      const asBale = {
        id: full.id,
        bale_no: full.bale_no,
        barcode: full.barcode,
        cubic: full.cubic,
        pieces: full.pieces,
        bl_no: row.bl_no,
        contract_no: row.contract_no,
        items: merged,
      }
      /**
       * 注意：这里必须用「刚拉回来的详情」覆盖列表里那份，
       * 不能因为列表里已经有这一包就保留旧对象——旧对象来自 /api/repacks/bales 的列表口径，
       * 早期版本那里缺 inbound_order_id，单价会算成 0。
       */
      setBales((prev) => [...prev.filter((b) => b.id !== asBale.id), asBale])
      setBaleId(full.id)
      setRows(merged.length > 0 ? merged.map(rowFromLine) : [createRow()])
      // 匹配到多个成本价的行先留空，等用户选
      setBeforePrices(
        Object.fromEntries(
          merged
            .filter((item) => item.price_ambiguous)
            .map((item) => [item.id as number, '']),
        ),
      )
      setForm((prev) => ({ ...prev, blNo: row.bl_no ?? '', contractNo: row.contract_no ?? '' }))
      setError('')
      setPickerOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取这一包失败')
    }
  }

  const loadPickerRows = useCallback(
    async (query: typeof pickerQuery, offset: number) => {
      setPickerLoading(true)
      try {
        const page = await fetchBales({
          keyword: query.keyword.trim() || undefined,
          warehouse: query.warehouse.trim() || undefined,
          status: query.status,
          date_from: query.date_from || undefined,
          date_to: query.date_to || undefined,
          limit: 20,
          offset,
        })
        setPickerRows(page.rows)
        setPickerTotal(page.total)
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载货物失败')
      } finally {
        setPickerLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    if (!pickerOpen) return
    void loadPickerRows(pickerQuery, pickerOffset)
  }, [pickerOpen, pickerQuery, pickerOffset, loadPickerRows])

  const copyBefore = () => {
    if (!bale) return
    setRows(bale.items.map(rowFromLine))
  }

  const updateRow = (key: number, field: keyof AfterRow, value: string) => {
    setRows((prev) =>
      prev.map((row) => (row.key === key ? { ...row, [field]: value } : row)),
    )
  }

  const addRow = () => setRows((prev) => [...prev, createRow()])

  /** 新增一行：复制当前最后一行的规格，省得重复填（单价不带过去，免得手滑钉住成本） */
  const copyLastRow = () =>
    setRows((prev) => {
      const last = prev[prev.length - 1]
      if (!last) return [...prev, createRow()]
      const { key, unitPrice, ...rest } = last
      void key
      void unitPrice
      return [...prev, { ...createRow(), ...rest }]
    })

  const removeRow = (key: number) => {
    // 只剩一行时不删也不清空：改包后至少要留一行规格（按钮那边也会置灰）
    setRows((prev) =>
      prev.length > 1 ? prev.filter((row) => row.key !== key) : prev,
    )
  }

  const handleSave = async () => {
    setError('')
    if (!bale) {
      setError('请先选择要改的那一包')
      return
    }
    // 改前成本有歧义、用户还没选 → 不让他保存（后端也会再拦一次）
    if (ambiguousCount > 0) {
      setError(
        `「改包前」里有 ${ambiguousCount} 行匹配到多个成本价，` +
          '请先在单价列里各选一个再保存',
      )
      return
    }
    const filled = rows.filter((row) => row.species.trim())
    if (filled.length === 0) {
      setError('改包后至少要有一行规格')
      return
    }

    const problems: string[] = []
    filled.forEach((row, index) => {
      const reasons: string[] = []
      if (!(toNumber(row.thickness) > 0)) reasons.push('厚度要大于 0')
      if (!(toNumber(row.width) > 0)) reasons.push('宽度要大于 0')
      if (!(toNumber(row.length) > 0)) reasons.push('长度要大于 0')
      if (!(Number.isInteger(toNumber(row.pieces)) && toNumber(row.pieces) > 0)) {
        reasons.push('片数要是大于 0 的整数')
      }
      if (reasons.length > 0) problems.push(`第 ${index + 1} 行：${reasons.join('；')}`)
    })
    if (problems.length > 0) {
      setError(problems.join('\n'))
      return
    }

    setSaving(true)
    try {
      const result = await createRepack({
        repack_date: form.repackDate,
        bale_id: bale.id,
        summary: form.summary.trim(),
        remark: form.remark.trim(),
        bl_no: form.blNo.trim(),
        contract_no: form.contractNo.trim(),
        // 改前选定的成本价（只有匹配到多个价的行才有值）
        before_prices: Object.fromEntries(
          Object.entries(beforePrices)
            .filter(([, value]) => value !== '')
            .map(([key, value]) => [key, toNumber(value)]),
        ),
        after_items: filled.map((row) => ({
          brand: row.brand.trim(),
          species: row.species.trim(),
          grade: row.grade.trim(),
          thickness: toNumber(row.thickness),
          width: toNumber(row.width),
          length: toNumber(row.length),
          pieces: toNumber(row.pieces),
          unit_price: toNumber(row.unitPrice),
        })),
      })
      setNotice(`已改包 ${result.repack_no}，库存已按新规格同步`)
      setBaleId(0)
      setRows([createRow()])
      setBeforePrices({})
      setForm((prev) => ({ ...prev, summary: '', remark: '', blNo: '', contractNo: '' }))
      setFormOpen(false)
      setReloadToken((n) => n + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : '改包失败')
    } finally {
      setSaving(false)
    }
  }

  const confirmUndo = async () => {
    if (!undoTarget) return
    try {
      await deleteRepack(undoTarget.id)
      setNotice(`已撤销改包 ${undoTarget.repack_no}，这一包的规格回到改包前`)
      setUndoTarget(null)
      setReloadToken((n) => n + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : '撤销失败')
      setUndoTarget(null)
    }
  }

  const lossCubic = roundTo(afterCubic - beforeCubic, 4)
  // 损耗率 = 损耗方数 ÷ 改前方数
  const lossRate = beforeCubic > 0 ? roundTo((lossCubic / beforeCubic) * 100, 2) : null
  const lossArrow = lossCubic > 0 ? '↑' : lossCubic < 0 ? '↓' : ''

  return (
    <section>
      <PageHead
        title="改包"
        subtitle={
          formOpen
            ? '选一包，改成品名 / 等级 / 规格，改前改后和损耗都留痕，库存跟着自动同步'
            : '一包货换了品名 / 等级 / 规格都记在这里，可查可撤销'
        }
        extra={
          formOpen ? (
            <button className="btn" onClick={() => setFormOpen(false)}>
              返回改包记录
            </button>
          ) : (
            <button className="btn btn-primary" onClick={() => setFormOpen(true)}>
              新增改包
            </button>
          )
        }
      />

      <ToastHost
        items={[
          notice
            ? {
                id: 'repack-notice',
                kind: 'success' as const,
                message: notice,
                onClose: () => setNotice(''),
              }
            : null,
          error
            ? {
                id: 'repack-error',
                kind: 'error' as const,
                message: error,
                onClose: () => setError(''),
              }
            : null,
        ]}
      />

      <datalist id="repack-species">
        {dict.species.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <datalist id="repack-grade">
        {dict.grade.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>

      {/* 录入界面：点「新增改包」才出现 */}
      {formOpen && (
        <div className="card sheet">
        <div className="sheet-top">
          <label className="sheet-field">
            <span>日期</span>
            <input
              className="input"
              type="date"
              value={form.repackDate}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, repackDate: event.target.value }))
              }
            />
          </label>
          <label className="sheet-field">
            <span>单号</span>
            <input className="input input-readonly" readOnly value="默认系统生成" />
          </label>
          <label className="sheet-field">
            <span>摘要</span>
            <input
              className="input"
              placeholder="例如：1 改 2"
              value={form.summary}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, summary: event.target.value }))
              }
            />
          </label>
          <span className="spacer" />
          <button className="btn btn-primary" onClick={() => void handleSave()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>

        {/* 改包前：只读 */}
        <div className="sheet-toolbar">
          <span className="section-tag">改包前</span>
          <button className="btn btn-sm btn-primary" onClick={() => setPickerOpen(true)}>
            选择货物
          </button>
          <span className="muted">
            {bale
              ? `已选 ${bale.barcode || bale.bale_no} · 包号 ${bale.bale_no || '—'}`
              : '还没选货'}
          </span>
          <span className="spacer" />
          <span className="muted">
            {bale
              ? `提单 ${bale.bl_no || '—'}　合同 ${bale.contract_no || '—'}`
              : `在库可改包的码单 ${bales.length} 张`}
          </span>
        </div>

        {ambiguousCount > 0 && (
          <p className="sheet-alert">
            有 {ambiguousCount} 行在入库明细里匹配到多个成本价（同一规格不同品牌），
            请在下面「单价」里各选一个再保存 —— 系统不会替你猜。
          </p>
        )}

        <div className="sheet-scroll">
          <table className="sheet-table">
            <thead>
              <tr>
                <th className="col-no">#</th>
                <th>包号</th>
                <th>品牌</th>
                <th className="col-name">品名</th>
                <th>等级</th>
                <th>厚度</th>
                <th>宽度</th>
                <th>长度</th>
                <th>片数</th>
                <th className="col-unit">立方 (m³)</th>
                <th className="col-unit">单位</th>
                <th>单价</th>
                <th>金额</th>
                <th className="col-code">条码号</th>
              </tr>
            </thead>
            <tbody>
              {bale ? (
                bale.items.map((line, index) => (
                  <tr key={`${line.species}-${index}`}>
                    <td className="col-no">{index + 1}</td>
                    <td>{bale.bale_no || '—'}</td>
                    <td>{line.brand || '—'}</td>
                    <td>{line.species}</td>
                    <td>{line.grade || '—'}</td>
                    <td>{line.thickness}</td>
                    <td>{line.width}</td>
                    <td>{line.length}</td>
                    <td>{line.pieces}</td>
                    <td className="col-unit num">{formatCubic(lineCubic(line))}</td>
                    <td className="col-unit">m³</td>
                    <td className="num">
                      {isPriceAmbiguous(line) && line.id !== undefined ? (
                        <select
                          className="sheet-input is-attention"
                          value={beforePrices[line.id] ?? ''}
                          onChange={(event) =>
                            setBeforePrices((prev) => ({
                              ...prev,
                              [line.id as number]: event.target.value,
                            }))
                          }
                        >
                          <option value="">请选择成本价</option>
                          {(line.price_candidates ?? []).map((candidate) => (
                            <option
                              key={`${candidate.order_item_id}-${candidate.unit_price}`}
                              value={String(candidate.unit_price)}
                            >
                              {formatAmount(candidate.unit_price)}
                              {candidate.brand ? `（${candidate.brand}）` : ''}
                              {candidate.count > 1 ? ` ×${candidate.count}` : ''}
                            </option>
                          ))}
                        </select>
                      ) : (
                        formatAmount(beforePriceOf(line))
                      )}
                    </td>
                    <td className="num">
                      {isPriceAmbiguous(line) && line.id !== undefined && !beforePrices[line.id]
                        ? '—'
                        : formatAmount(lineCubic(line) * beforePriceOf(line))}
                    </td>
                    <td className="col-code">{bale.barcode || '—'}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={14} className="sheet-empty">
                    上面选一包，这里就会显示它改之前的规格
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={9} className="sheet-total-label">
                  合计
                </td>
                <td className="num">{formatCubic(beforeCubic)}</td>
                <td>m³</td>
                <td />
                <td className="num">{formatAmount(beforeAmount)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>

        {/* 改包后：可编辑 */}
        <div className="sheet-toolbar">
          <span className="section-tag">改包后</span>
          <button className="btn btn-sm" onClick={copyBefore} disabled={!bale}>
            复制改包前数据
          </button>
            <button className="btn btn-sm" onClick={copyLastRow}>
              + 新增（复制当前行）
            </button>
            <button className="btn btn-sm" onClick={addRow}>
              + 空白行
            </button>
          <span className="spacer" />
          <span className="muted">
            单价留空 = 按「改前总成本 ÷ 改后总方数」自动算；自己填了就以你填的为准
          </span>
        </div>

        <div className="sheet-scroll">
          <table className="sheet-table">
            <thead>
              <tr>
                <th className="col-no">#</th>
                <th>包号</th>
                <th>品牌</th>
                <th className="col-name">品名 *</th>
                <th>等级</th>
                <th>厚度</th>
                <th>宽度</th>
                <th>长度</th>
                <th>片数</th>
                <th className="col-unit">立方 (m³)</th>
                <th className="col-unit">单位</th>
                <th>单价{pinned ? '' : '（自动）'}</th>
                <th>金额</th>
                {/* 这一列只放一个删行按钮，不写表头文字（免得被读成「操作✕」） */}
                <th className="col-op" aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const cubic = rowCubic(row)
                return (
                  <tr key={row.key}>
                    <td className="col-no">{index + 1}</td>
                    {/* 包号：改的是这一包，包号不会变，放在最前面只读展示 */}
                    <td>{bale?.bale_no || '—'}</td>
                    <td>
                      <input
                        className="sheet-input"
                        value={row.brand}
                        onChange={(event) => updateRow(row.key, 'brand', event.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        className="sheet-input"
                        list="repack-species"
                        value={row.species}
                        onChange={(event) => updateRow(row.key, 'species', event.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        className="sheet-input"
                        list="repack-grade"
                        value={row.grade}
                        onChange={(event) => updateRow(row.key, 'grade', event.target.value)}
                      />
                    </td>
                    {(['thickness', 'width', 'length', 'pieces'] as const).map((field) => (
                      <td key={field}>
                        <input
                          className="sheet-input"
                          type="text"
                          inputMode="decimal"
                          value={row[field]}
                          onChange={(event) => updateRow(row.key, field, event.target.value)}
                        />
                      </td>
                    ))}
                    <td className="col-unit num">{cubic ? formatCubic(cubic) : ''}</td>
                    <td className="col-unit">{cubic ? 'm³' : ''}</td>
                    <td>
                      <input
                        className="sheet-input"
                        type="text"
                        inputMode="decimal"
                        placeholder={derivedPrice ? String(derivedPrice) : '自动'}
                        value={row.unitPrice}
                        onChange={(event) => updateRow(row.key, 'unitPrice', event.target.value)}
                      />
                    </td>
                    <td className="num">{cubic ? formatAmount(cubic * priceOf(row)) : ''}</td>
                    <td className="col-op">
                      {/* title 挂在 span 上：按钮 disabled 时原生 tooltip 不弹，外面的包裹层还能弹 */}
                      <span
                        title={
                          rows.length <= 1 ? '改包后至少要保留一行规格' : '删掉这一行'
                        }
                      >
                        <button
                          type="button"
                          className="sheet-icon sheet-icon-danger"
                          disabled={rows.length <= 1}
                          onClick={() => removeRow(row.key)}
                        >
                          ✕
                        </button>
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={9} className="sheet-total-label">
                  合计
                </td>
                <td className="num">{formatCubic(afterCubic)}</td>
                <td>m³</td>
                <td />
                <td className="num">{formatAmount(afterAmount)}</td>
                <td />
              </tr>
              <tr>
                <td colSpan={9} className="sheet-total-label">
                  损耗（改后 − 改前）
                </td>
                <td className={lossCubic < 0 ? 'num is-short' : 'num'}>
                  {formatCubic(lossCubic)} {lossArrow}
                </td>
                <td>
                  {lossRate === null ? '—' : `${lossRate}% ${lossArrow}`}
                </td>
                <td />
                <td className="num">
                  {formatAmount(roundTo(afterAmount - beforeAmount, 2))}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="sheet-bottom">
          <label className="sheet-field">
            <span>提单号（留空就跟改前一致）</span>
            <input
              className="input"
              value={form.blNo}
              onChange={(event) => setForm((prev) => ({ ...prev, blNo: event.target.value }))}
            />
            {!form.blNo.trim() && bale?.bl_no && (
              <span className="hint">
                改前提单号是 {bale.bl_no}，你留空了 —— 保存时会自动同步成 {bale.bl_no}
              </span>
            )}
          </label>
          <label className="sheet-field">
            <span>合同号（留空就跟改前一致）</span>
            <input
              className="input"
              value={form.contractNo}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, contractNo: event.target.value }))
              }
            />
            {!form.contractNo.trim() && bale?.contract_no && (
              <span className="hint">
                改前合同号是 {bale.contract_no}，你留空了 —— 保存时会自动同步
              </span>
            )}
          </label>
        </div>

        <textarea
          className="input textarea sheet-note"
          placeholder="备注（选填）"
          value={form.remark}
          onChange={(event) => setForm((prev) => ({ ...prev, remark: event.target.value }))}
        />

        <p className="hint">
          提单号 / 合同号留空时跟着改前那一包走；填了就按你填的记进改包记录。
        </p>
        </div>
      )}

      {/* 改包记录：进来先看这个 */}
      {!formOpen && (
        <div className="card">
        <h2 className="section-title">改包记录</h2>

        <div className="toolbar">
          <input
            className="input"
            type="date"
            value={filters.date_to}
            onChange={(event) =>
              setFilters((prev) => ({ ...prev, date_to: event.target.value }))
            }
          />
          <input
            className="input"
            placeholder="品名关键字"
            value={filters.species}
            onChange={(event) =>
              setFilters((prev) => ({ ...prev, species: event.target.value }))
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                setOffset(0)
                setQuery(filters)
              }
            }}
          />
          <button
            className="btn"
            onClick={() => {
              setOffset(0)
              setQuery(filters)
            }}
          >
            查询
          </button>
          <button
            className="btn"
            onClick={() => {
              const empty = { date_to: '', species: '' }
              setFilters(empty)
              setOffset(0)
              setQuery(empty)
            }}
          >
            重置
          </button>
        </div>

        <table className="table">
          <thead>
            <tr>
              <th>日期</th>
              <th>单号</th>
              <th>包号</th>
              <th>条码号</th>
              <th>提单号</th>
              <th>改前</th>
              <th>改后</th>
              <th className="num">改前立方</th>
              <th className="num">改后立方</th>
              <th className="num">改前金额</th>
              <th className="num">改后金额</th>
              <th className="num">损耗</th>
              <th className="num">损耗率</th>
              <th>摘要</th>
              <th>制单人</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {list.map((row) => (
              <tr key={row.id}>
                <td>{row.repack_date}</td>
                <td>{row.repack_no}</td>
                <td>{row.bale_no || '—'}</td>
                <td>{row.barcode || '—'}</td>
                <td>{row.bl_no || '—'}</td>
                <td>
                  {row.before_items
                    .map(
                      (line) =>
                        `${line.brand ? `${line.brand}/` : ''}${line.species}` +
                        `${line.grade ? `/${line.grade}` : ''}`,
                    )
                    .join('、') || '—'}
                </td>
                <td>
                  {row.after_items
                    .map(
                      (line) =>
                        `${line.brand ? `${line.brand}/` : ''}${line.species}` +
                        `${line.grade ? `/${line.grade}` : ''}`,
                    )
                    .join('、') || '—'}
                </td>
                <td className="num">{formatCubic(row.before_cubic)}</td>
                <td className="num">{formatCubic(row.after_cubic)}</td>
                <td className="num">{formatAmount(row.before_amount)}</td>
                <td className="num">{formatAmount(row.after_amount)}</td>
                <td className={row.loss_cubic < 0 ? 'num is-short' : 'num'}>
                  {formatCubic(row.loss_cubic)}
                  {row.loss_cubic > 0 ? ' ↑' : row.loss_cubic < 0 ? ' ↓' : ''}
                </td>
                <td className="num">
                  {row.loss_rate === null ? '—' : `${row.loss_rate}%`}
                  {row.loss_rate === null
                    ? ''
                    : row.loss_rate > 0
                      ? ' ↑'
                      : row.loss_rate < 0
                        ? ' ↓'
                        : ''}
                </td>
                <td>{row.summary || '—'}</td>
                <td>{row.created_by || '—'}</td>
                <td>
                  <button className="btn btn-sm btn-danger" onClick={() => setUndoTarget(row)}>
                    撤销
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={7} className="sheet-total-label">
                合计
              </td>
              <td className="num">{formatCubic(sums?.before_cubic ?? 0)}</td>
              <td className="num">{formatCubic(sums?.after_cubic ?? 0)}</td>
              <td className="num">{formatAmount(sums?.before_amount ?? 0)}</td>
              <td className="num">{formatAmount(sums?.after_amount ?? 0)}</td>
              <td className="num">{formatCubic(sums?.loss_cubic ?? 0)}</td>
              <td colSpan={4} />
            </tr>
          </tfoot>
        </table>

        {!loading && list.length === 0 && <EmptyState text="还没有改包记录" />}
        {loading && <Loading />}

        <Pager
          total={total}
          limit={PAGE_SIZE}
          offset={offset}
          onChange={setOffset}
          unit="条改包记录"
        />
        </div>
      )}

      {undoTarget && (
        <div className="overlay" onClick={() => setUndoTarget(null)}>
          <div
            className="modal modal-narrow modal-alert"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="modal-title">撤销改包</h2>
            <p className="confirm-text">
              确认撤销改包 {undoTarget.repack_no}？这一包的规格会回到改包前
              （{undoTarget.before_items.map((line) => line.species).join('、') || '—'}），
              库存跟着改回去，这条记录也会删掉。
            </p>
            <div className="confirm-actions">
              <button className="btn" onClick={() => setUndoTarget(null)}>
                取消
              </button>
              <button className="btn btn-danger-solid" onClick={() => void confirmUndo()}>
                确认撤销
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 选择货物：搜索 + 筛选 + 分页，选中后自动带出这一包的规格 */}
      {pickerOpen && (
        <div className="overlay" onClick={() => setPickerOpen(false)}>
          <div className="modal modal-xwide modal-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h2 className="modal-title">选择货物</h2>
              <button className="btn btn-sm btn-quiet" onClick={() => setPickerOpen(false)}>
                关闭
              </button>
            </div>

            <div className="toolbar">
              <input
                className="input"
                placeholder="包号 / 品名 / 等级 / 柜号 / 提单号"
                value={pickerQuery.keyword}
                onChange={(event) =>
                  setPickerQuery((prev) => ({ ...prev, keyword: event.target.value }))
                }
                onKeyDown={(event) => {
                  if (event.key === 'Enter') setPickerOffset(0)
                }}
              />
              <input
                className="input"
                placeholder="仓库"
                value={pickerQuery.warehouse}
                onChange={(event) =>
                  setPickerQuery((prev) => ({ ...prev, warehouse: event.target.value }))
                }
              />
              <select
                className="input"
                value={pickerQuery.status}
                onChange={(event) =>
                  setPickerQuery((prev) => ({
                    ...prev,
                    status: event.target.value as '' | 'in_stock' | 'shipped',
                  }))
                }
              >
                <option value="">全部状态</option>
                <option value="in_stock">在库</option>
                <option value="shipped">已出库</option>
              </select>
              <input
                className="input"
                type="date"
                value={pickerQuery.date_from}
                onChange={(event) =>
                  setPickerQuery((prev) => ({ ...prev, date_from: event.target.value }))
                }
              />
              <span className="muted">至</span>
              <input
                className="input"
                type="date"
                value={pickerQuery.date_to}
                onChange={(event) =>
                  setPickerQuery((prev) => ({ ...prev, date_to: event.target.value }))
                }
              />
              <button className="btn" onClick={() => setPickerOffset(0)}>
                查询
              </button>
              <button
                className="btn"
                onClick={() => {
                  setPickerQuery({
                    keyword: '',
                    warehouse: '',
                    status: 'in_stock',
                    date_from: '',
                    date_to: '',
                  })
                  setPickerOffset(0)
                }}
              >
                重置
              </button>
              <span className="spacer" />
              <span className="muted">共 {pickerTotal} 包</span>
            </div>

            <table className="table">
              <thead>
                <tr>
                  <th>包号</th>
                  <th>品名</th>
                  <th>等级</th>
                  <th className="num">厚×宽×长</th>
                  <th className="num">片数</th>
                  <th className="num">立方</th>
                  <th>柜号</th>
                  <th>提单码</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {pickerRows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.bale_no || '—'}</td>
                    <td>{row.species}</td>
                    <td>{row.grade || '—'}</td>
                    <td className="num">
                      {row.thickness}×{row.width}×{row.length}
                    </td>
                    <td className="num">{row.pieces}</td>
                    <td className="num">{formatCubic(row.cubic)}</td>
                    <td>{row.box_no || '—'}</td>
                    <td>{row.bl_no || '—'}</td>
                    <td>
                      <span className={row.status === 'in_stock' ? 'tag tag-in' : 'tag tag-out'}>
                        {row.status === 'in_stock' ? '在库' : '已出库'}
                      </span>
                    </td>
                    <td>
                      <button className="btn btn-sm btn-primary" onClick={() => void pickFromPicker(row)}>
                        选择
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {!pickerLoading && pickerRows.length === 0 && (
              <EmptyState text="没有找到符合条件的包" />
            )}
            {pickerLoading && <Loading />}

            <Pager
              total={pickerTotal}
              limit={20}
              offset={pickerOffset}
              onChange={setPickerOffset}
              unit="个包"
            />
          </div>
        </div>
      )}
    </section>
  )
}
