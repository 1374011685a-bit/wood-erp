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
import { useRole } from '../hooks/useRole'
import { seesMoney } from '../permissions'

const PAGE_SIZE = 20

/** 改包后的一行（一包里的一个规格） */
type AfterRow = {
  key: number
  /**
   * 这一行归到哪个新包。
   *
   * 保存时的分组规则（只看这个字段，没有别的隐藏状态）：
   *   - 包号非空 → 按包号归组：写一样的包号 = 同一包（一包可以有几行规格 = 混装包）
   *   - 包号为空 → 这一行自己一包
   *
   * 所以「复制改包前数据」出来的一行（包号空）就是一包；
   * 「一键拆包」出来的三行（包号都空）就是三包 —— 跟手动一行一行填的结果完全一致。
   */
  baleNo: string
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

const rowFromLine = (line: RepackLine): AfterRow => ({
  key: (rowSeq += 1),
  baleNo: '',
  brand: line.brand ?? '',
  species: line.species ?? '',
  grade: line.grade ?? '',
  thickness: String(line.thickness ?? ''),
  width: String(line.width ?? ''),
  // 混装行按原文（斜杠串）搬回来，编辑记录时才能原样摆回去
  length: line.length_text ?? String(line.length ?? ''),
  pieces: line.pieces_text ?? String(line.pieces ?? ''),
  unitPrice: '',
})

/** 「改包后」默认铺几行空行（常驻，等仓管自己填 / 复制 / 拆） */
const AFTER_BLANK_ROWS = 5
const blankRows = () => Array.from({ length: AFTER_BLANK_ROWS }, () => createRow())

/**
 * 两张表的列数 / 合计行跨列。
 * 合计行的 colspan 一律从这里倒推 —— 写死数字的话，加一列就会错位。
 *   改包前：# 包号 品牌 品名 等级 厚 宽 长 片数 立方 单位 [单价] [金额] 条码号
 *   改包后：# 旧包号 新包号 品牌 品名 等级 厚 宽 长 片数 立方 单位 [单价] [金额] 操作
 */
const BEFORE_COLS = 14
const BEFORE_LEAD_COLS = 9
const AFTER_COLS = 15
const AFTER_LEAD_COLS = 10

/** 斜杠串拆成各段（`1.8/2.1/2.4` → ['1.8','2.1','2.4']；单值 → 一段） */
const slashSegments = (text: string) =>
  String(text ?? '')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part !== '')

/** 长度按「大于 20 当毫米」换算成米，和后端 / 入库那边一套口径 */
const toMetersText = (raw: string) => {
  const num = Number(String(raw ?? '').trim())
  if (!Number.isFinite(num) || num <= 0) return NaN
  return num > 20 ? num / 1000 : num
}

/**
 * 一行的各段规格：`[{ length, pieces }]`。
 * 长度和片数的段数不一致（或者长度空着）→ 空数组，校验那边会报出来。
 */
const rowSpecs = (row: AfterRow) => {
  const lengths = slashSegments(row.length)
  const pieces = slashSegments(row.pieces)
  if (lengths.length === 0 || lengths.length !== pieces.length) return []
  return lengths.map((length, index) => ({
    length: toMetersText(length),
    pieces: Number(pieces[index]),
  }))
}

/** 一行的立方：各段「厚 × 宽 × 长 × 片数 ÷ 1,000,000」相加（一包就是一件） */
const rowCubic = (row: AfterRow) =>
  roundTo(
    rowSpecs(row).reduce((sum, spec) => {
      if (!Number.isFinite(spec.length)) return sum
      return (
        sum +
        (toNumber(row.thickness) * toNumber(row.width) * spec.length * spec.pieces) / 1000000
      )
    }, 0),
    4,
  )

const lineCubic = (line: RepackLine) => roundTo(line.cubic ?? 0, 4)

/** 改前这一行匹配到多个成本价时，用户必须选一个（见 beforePrices） */
const isPriceAmbiguous = (line: RepackLine) => Boolean(line.price_ambiguous)

export default function Repack() {
  /**
   * 看不到金额的角色（仓管）：立方、损耗、损耗率照常显示，
   * 单价 / 金额 / 改前改后金额全部不渲染，单价输入框也不给 ——
   * 成本由后端按「改前总成本 ÷ 改后总方数」自己算，前端不碰。
   */
  const money = seesMoney(useRole())

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
  const [rows, setRows] = useState<AfterRow[]>(() => blankRows())
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
  /** 「查看」：只看这条改包的改前 / 改后明细，不改任何东西 */
  const [viewTarget, setViewTarget] = useState<RepackRow | null>(null)
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
  // 「改包前」那一行的长度 / 片数斜杠串（混装包 1.8/2.1/2.4、17/30/247）
  const beforeLengthText = (bale?.items ?? []).map((line) => line.length).join('/')
  const beforePiecesText = (bale?.items ?? []).map((line) => line.pieces).join('/')
  /** 成本价有歧义的行 —— 这些行还是要让用户逐行选，所以单独列在下面 */
  const ambiguousLines = (bale?.items ?? []).filter(
    (line) => line.id !== undefined && isPriceAmbiguous(line),
  )

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
      /**
       * 「改包后」默认留空 —— 系统不自作主张复制、也不自动拆。
       * 仓管自己选：复制改包前数据 / 一键拆包 / 手动加行。
       */
      setRows(blankRows())
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

  /**
   * 复制改包前数据 = 把「改包前」那**一行**原样搬过来：不拆、不改。
   *
   * 混装包搬过来仍然是斜杠串的一行（长度 1.8/2.1/2.4 配片数 17/30/247），
   * 包号留空 —— 这一行就是这一包，保存下去还是同一个包、同样的规格。
   * （要按长度拆成几包，用旁边那个「一键拆包（按长度）」。）
   */
  const copyBefore = () => {
    if (!bale) return
    const items = bale.items
    if (items.length === 0) return
    const first = items[0]
    setRows([
      {
        ...createRow(),
        brand: first.brand ?? '',
        species: first.species ?? '',
        grade: first.grade ?? '',
        thickness: String(first.thickness ?? ''),
        width: String(first.width ?? ''),
        length: items.map((line) => line.length).join('/'),
        pieces: items.map((line) => line.pieces).join('/'),
      },
    ])
  }

  const updateRow = (key: number, field: keyof AfterRow, value: string) => {
    setRows((prev) =>
      prev.map((row) => (row.key === key ? { ...row, [field]: value } : row)),
    )
  }

  /** ＋ 空白行：末尾加一行空的 */
  const addRow = () => setRows((prev) => [...prev, createRow()])

  /**
   * 复制本行：字段照抄、包号清空、插到本行下面（第 N 行 → 新行落在 N+1）。
   * 单价不带过去 —— 留空才是「按改前成本自动算」，免得手滑把成本钉住。
   */
  const copyRow = (key: number) =>
    setRows((prev) => {
      const index = prev.findIndex((row) => row.key === key)
      if (index < 0) return prev
      const row = prev[index]
      const next = [...prev]
      next.splice(index + 1, 0, {
        ...createRow(),
        brand: row.brand,
        species: row.species,
        grade: row.grade,
        thickness: row.thickness,
        width: row.width,
        length: row.length,
        pieces: row.pieces,
      })
      return next
    })

  const removeRow = (key: number) => {
    // 只剩一行时不删也不清空：改包后至少要留一行规格（按钮那边也会置灰）
    setRows((prev) =>
      prev.length > 1 ? prev.filter((row) => row.key !== key) : prev,
    )
  }

  /** 这一包是不是混装包（多行规格、长度不同）——「一键拆包」只在这是真的时才给点 */
  const isMixedBale = (bale?.items.length ?? 0) > 1

  /**
   * 一键拆包（按长度）：把「改包前」的每一行规格提成一行，按长度各分一个新包号。
   *
   * 手动触发，绝不自动跑；跑完结果摆在表里，用户可以改、可以删、可以再合并，
   * 不点保存什么都不算数。
   */
  const splitByLength = () => {
    if (!bale) return
    /**
     * 一行规格 = 一包，每行给新的 groupKey、**包号一律留空**。
     * 不自动生成 P1/P2/P3 —— 包号是仓管从货上抄的，系统不替他编
     * （groupKey 保证它们各自成包，不会被合并）。
     */
    setRows(bale.items.map((line) => ({ ...rowFromLine(line), baleNo: '' })))
  }

  /**
   * 改包后分组：一组 = 一个新包。只看「新包号」这一个字段：
   *   包号非空 → 按包号归组（填成一样 = 同一包，也就是混装包）
   *   包号为空 → 这一行自己一包
   *
   * 没有隐藏状态，所以「一键拆包」「复制改包前数据」「手动一行一行填」
   * 只要表里的行一样，保存结果就一定一样。
   */
  const groupRows = (list: AfterRow[]) => {
    const groups: { baleNo: string; rows: AfterRow[] }[] = []
    const byBaleNo = new Map<string, AfterRow[]>()

    for (const row of list) {
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
      if (slashSegments(row.thickness).length > 1) reasons.push('厚度只能填一个数')
      if (!(toNumber(row.width) > 0)) reasons.push('宽度要大于 0')
      if (slashSegments(row.width).length > 1) reasons.push('宽度只能填一个数')

      /**
       * 长度 / 片数可以写多段（混装包：1.8/2.1/2.4 配 17/30/247）。
       * 规则和后端 normalizeBaleItems 完全一致：段数必须一样多，逐段校验。
       */
      const lengths = slashSegments(row.length)
      const pieces = slashSegments(row.pieces)
      if (lengths.length === 0) {
        reasons.push('长度要大于 0')
      } else if (lengths.length !== pieces.length) {
        reasons.push(
          '长度和片数的段数要一样多（如长度 1.8/2.1/2.4 配片数 17/30/247）',
        )
      } else {
        rowSpecs(row).forEach((spec, seg) => {
          const at = lengths.length > 1 ? `第 ${seg + 1} 段` : ''
          if (!(spec.length > 0 && spec.length <= 20)) reasons.push(`${at}长度要在 0~20m`)
          if (!(Number.isInteger(spec.pieces) && spec.pieces > 0)) {
            reasons.push(`${at}片数要是大于 0 的整数`)
          }
        })
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
        /**
         * 按「新包号」分组发上去：一组 = 一个包。
         * 只填了一行（或者只填一个包号）→ 只有一组 → 后端按「改这一包的规格」处理。
         * 长度 / 片数原样发字符串：混装行的斜杠串要在后端摊成几段。
         */
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
          })),
        })),
      })
      const split = (result.bale_count ?? 1) > 1
      setNotice(
        split
          ? `已拆包 ${result.repack_no}：原包消失，拆成 ${result.bale_count} 个新包`
          : `已改包 ${result.repack_no}，库存已按新规格同步`,
      )
      setBaleId(0)
      setRows(blankRows())
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
      setNotice(
        undoTarget.kind === 'split'
          ? `已撤销拆包 ${undoTarget.repack_no}，拆出来的包已删掉，原包回来了`
          : `已撤销改包 ${undoTarget.repack_no}，这一包的规格回到改包前`,
      )
      setUndoTarget(null)
      setReloadToken((n) => n + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : '撤销失败')
      setUndoTarget(null)
    }
  }

  /**
   * 编辑一条改包记录 = **先撤销这条记录**（原包回来、拆出来的包删掉），
   * 再把这次的「改后」状态填进改包页重新走一遍，保存后生成一条新记录。
   *
   * 为什么不直接改记录：这条记录是留痕快照（改前 / 改后原文），
   * 就地改内容等于把账做平了 —— 撤销 + 重做在数据上完全等价，但每一笔都对得上。
   */
  const editRepack = async (row: RepackRow) => {
    setError('')
    try {
      await deleteRepack(row.id)
      setNotice(`已撤销 ${row.repack_no}，下面按这次的结果重新拆一次，保存后会生成新记录`)
      setReloadToken((n) => n + 1)

      // 撤销之后原包回来了，拉它的详情当「改包前」
      if (!row.bale_id) {
        setError('这条记录没有关联的包，无法编辑')
        return
      }
      const full = await fetchBaleDetail(row.bale_id)
      const asBale: RepackBale = {
        id: full.id,
        bale_no: full.bale_no,
        barcode: full.barcode,
        cubic: full.cubic,
        pieces: full.pieces,
        bl_no: row.bl_no,
        contract_no: row.contract_no,
        items: full.items.map((item) => ({
          ...item,
          price_ambiguous: false,
        })) as RepackBale['items'],
      }
      setBales((prev) => [...prev.filter((b) => b.id !== asBale.id), asBale])
      setBaleId(full.id)
      setBeforePrices({})

      // 把「改后」恢复出来：拆包的按包分组，改规格的就是一组
      const restored = (row.after_bales ?? []).flatMap((group) =>
        group.items.map((line) => ({ line, baleNo: group.bale_no })),
      )
      const flat =
        restored.length > 0
          ? restored
          : row.after_items.map((line) => ({ line, baleNo: '' }))

      setRows(
        flat.length > 0
          ? flat.map(({ line, baleNo }) => ({
              ...rowFromLine(line as RepackLine),
              baleNo,
              unitPrice:
                line.unit_price === null || line.unit_price === undefined
                  ? ''
                  : String(line.unit_price),
            }))
          : blankRows(),
      )
      setForm((prev) => ({
        ...prev,
        summary: row.summary ?? '',
        remark: row.remark ?? '',
        blNo: row.bl_no ?? '',
        contractNo: row.contract_no ?? '',
      }))
      setFormOpen(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : '打开编辑失败')
    }
  }

  const lossCubic = roundTo(afterCubic - beforeCubic, 4)
  // 损耗率 = 损耗方数 ÷ 改前方数
  const lossRate = beforeCubic > 0 ? roundTo((lossCubic / beforeCubic) * 100, 2) : null
  const lossArrow = lossCubic > 0 ? '↑' : lossCubic < 0 ? '↓' : ''

  /** 查看弹窗里的一小块规格表（改前 / 改后共用） */
  const renderSpecTable = (items: RepackRow['after_items']) => {
    /**
     * 同一个包里的混装行（品名 / 等级 / 厚度 / 宽度一样，只有长度不同）合成一行：
     * 长度 / 片数写斜杠串 —— 和列表、改包页一个口径。
     */
    const specKeyOf = (line: RepackLine) =>
      [line.species, line.grade ?? '', line.thickness, line.width].join('|')
    const merged: RepackLine[] = []
    for (const line of items) {
      const key = specKeyOf(line)
      const last = merged[merged.length - 1]
      if (last && specKeyOf(last) === key && last.length_text) {
        last.length_text = `${last.length_text}/${line.length}`
        last.pieces_text = `${last.pieces_text}/${line.pieces}`
        last.cubic = roundTo((last.cubic ?? 0) + (line.cubic ?? 0), 4)
        continue
      }
      merged.push({
        ...line,
        length_text: line.length_text ?? String(line.length),
        pieces_text: line.pieces_text ?? String(line.pieces),
      })
    }

    return (
    <table className="table">
      <thead>
        <tr>
          <th>品牌</th>
          <th>品名</th>
          <th>等级</th>
          <th className="num">厚度 (mm)</th>
          <th className="num">宽度 (mm)</th>
          <th className="num">长度 (m)</th>
          <th className="num">片数</th>
          <th className="num">立方</th>
        </tr>
      </thead>
      <tbody>
        {merged.map((line, index) => (
          <tr key={`${line.species}-${line.length}-${index}`}>
            <td>{line.brand || '—'}</td>
            <td>{line.species}</td>
            <td>{line.grade || '—'}</td>
            {/* 混装行按原样显示斜杠串（1.8/2.1/2.4、17/30/247） */}
            <td className="num">{line.thickness}</td>
            <td className="num">{line.width}</td>
            <td className="num">{line.length_text ?? line.length}</td>
            <td className="num">{line.pieces_text ?? line.pieces}</td>
            <td className="num">{formatCubic(line.cubic)}</td>
          </tr>
        ))}
      </tbody>
    </table>
    )
  }

  return (
    <section>
      <PageHead
        title="改包"
        subtitle={
          formOpen
            ? '选一包，拆成规格统一的几包；也可以只改品名 / 等级 / 规格。改前改后和损耗都留痕'
            : '一包货拆成了哪几包、改成了什么规格，都记在这里，可查、可编辑、可撤销'
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
                {/* 仓管这类看不到金额的角色：单价 / 金额两列不显示，立方和损耗照旧 */}
                {money && <th>单价</th>}
                {money && <th>金额</th>}
                <th className="col-code">条码号</th>
              </tr>
            </thead>
            <tbody>
              {bale ? (
                <>
                {/* 混装包在这里是**一行**，不是摊成几行：长度片数写斜杠串（1.8/2.1/2.4、17/30/247），
                    立方是这包的合计。要拆成几包是下面「改包后」的事，由仓管点「一键拆包」手动触发 */}
                <tr>
                  <td className="col-no">1</td>
                  <td>{bale.bale_no || '—'}</td>
                  <td>{bale.items[0]?.brand || '—'}</td>
                  <td>{bale.items[0]?.species || '—'}</td>
                  <td>{bale.items[0]?.grade || '—'}</td>
                  <td>{bale.items[0]?.thickness ?? '—'}</td>
                  <td>{bale.items[0]?.width ?? '—'}</td>
                  <td>{beforeLengthText}</td>
                  <td>{beforePiecesText}</td>
                  <td className="col-unit num">{formatCubic(beforeCubic)}</td>
                  <td className="col-unit">m³</td>
                  {money && (
                    <td className="num">
                      {ambiguousCount > 0 ? (
                        <select
                          className="sheet-input is-attention"
                          value=""
                          onChange={() => {}}
                        >
                          <option value="">
                            有 {ambiguousCount} 行要选成本价（在下面明细里选）
                          </option>
                        </select>
                      ) : (
                        formatAmount(beforeCubic > 0 ? beforeAmount / beforeCubic : 0)
                      )}
                    </td>
                  )}
                  {money && <td className="num">{formatAmount(beforeAmount)}</td>}
                  <td className="col-code">{bale.barcode || '—'}</td>
                </tr>

                {/* 成本价匹配到多行的，逐行让用户挑一个（挑完才能保存） */}
                {ambiguousLines.map((line) => (
                  <tr key={`pick-${line.id}`}>
                    <td colSpan={money ? BEFORE_COLS : BEFORE_COLS - 2}>
                      <div className="same-bale-cell">
                        <span className="muted">
                          这一包里「{line.species} {line.grade} {line.thickness}×{line.width}×
                          {line.length}，{line.pieces} 片」匹配到多个成本价，选一个：
                        </span>
                        <select
                          className="sheet-input is-attention"
                          value={beforePrices[line.id as number] ?? ''}
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
                      </div>
                    </td>
                  </tr>
                ))}
                </>
              ) : (
                <tr>
                  <td colSpan={money ? BEFORE_COLS : BEFORE_COLS - 2} className="sheet-empty">
                    上面选一包，这里就会显示它改之前的规格
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                {/* 领先列：# / 包号 / 品牌 / 品名 / 等级 / 厚 / 宽 / 长 / 片数 = 9 */}
                <td colSpan={BEFORE_LEAD_COLS} className="sheet-total-label">
                  合计
                </td>
                <td className="num">{formatCubic(beforeCubic)}</td>
                <td>m³</td>
                {money && <td />}
                {money && <td className="num">{formatAmount(beforeAmount)}</td>}
                {/* 条码号那一列始终占位，不管看不看得到金额 */}
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
          {/* 只有混装包（一包多行规格）才需要拆，其余情况置灰并说明原因 */}
          <button
            className="btn btn-sm btn-primary"
            onClick={splitByLength}
            disabled={!isMixedBale}
            title={
              !bale
                ? '先在上面选一包货'
                : isMixedBale
                  ? '把这一包按长度拆成几包（结果可以再改，保存才生效）'
                  : '这一包只有一种规格，不需要拆'
            }
          >
            一键拆包（按长度）
          </button>
          <button className="btn btn-sm" onClick={addRow}>
            + 空白行
          </button>
          <span className="spacer" />
          <span className="muted">
            {rows.length === 0
              ? '改包后是空的：点「复制改包前数据」或「一键拆包」，也可以自己加行'
              : '「新包号」填一样的行算同一包（混装）；留空的每行各成一包'}
          </span>
        </div>

        <div className="sheet-scroll">
          <table className="sheet-table">
            <thead>
              <tr>
                <th className="col-no">#</th>
                {/* 原来的「包号」列是只读展示；这一列是新包的包号，可填 */}
                <th className="col-no">旧包号</th>
                <th className="col-split-no">新包号</th>
                <th>品牌</th>
                <th className="col-name">品名 *</th>
                <th>等级</th>
                <th>厚度</th>
                <th>宽度</th>
                <th>长度</th>
                <th>片数</th>
                <th className="col-unit">立方 (m³)</th>
                <th className="col-unit">单位</th>
                {/* 看不到金额的角色不显示单价输入：成本完全由后端按「改前总成本 ÷ 改后总方数」算 */}
                {money && <th>单价{pinned ? '' : '（自动）'}</th>}
                {money && <th>金额</th>}
                {/* 这一列只放一个删行按钮，不写表头文字（免得被读成「操作✕」） */}
                <th className="col-op" aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={money ? AFTER_COLS : AFTER_COLS - 2} className="sheet-empty">
                    还没有内容。点「复制改包前数据」原样搬过来，或点「一键拆包（按长度）」按长度拆开，
                    也可以「+ 空白行」自己一行一行填。
                  </td>
                </tr>
              )}
              {rows.map((row, index) => {
                const cubic = rowCubic(row)
                return (
                  <tr key={row.key}>
                    <td className="col-no">{index + 1}</td>
                    {/* 旧包号：只读展示，让人知道这一行原来属于哪一包 */}
                    <td className="col-no">{bale?.bale_no || '—'}</td>
                    {/* 新包号：相同的算同一包；留空就是空的，系统不会替你编一个 */}
                    <td className="col-split-no">
                      <input
                        className="sheet-input"
                        placeholder="可留空"
                        value={row.baleNo}
                        onChange={(event) => updateRow(row.key, 'baleNo', event.target.value)}
                      />
                    </td>
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
                    {money && (
                      <td>
                        <input
                          className="sheet-input"
                          type="text"
                          inputMode="decimal"
                          placeholder={derivedPrice ? String(derivedPrice) : '自动'}
                          value={row.unitPrice}
                          onChange={(event) =>
                            updateRow(row.key, 'unitPrice', event.target.value)
                          }
                        />
                      </td>
                    )}
                    {money && (
                      <td className="num">
                        {cubic ? formatAmount(cubic * priceOf(row)) : ''}
                      </td>
                    )}
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
                      {/* 右 ＋：复制本行（字段照抄、包号清空、插到本行下面） */}
                      <button
                        type="button"
                        className="sheet-icon"
                        title="复制本行（包号会清空，自己填）"
                        onClick={() => copyRow(row.key)}
                      >
                        ＋
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr>
                {/* 领先列：# / 旧包号 / 新包号 / 品牌 / 品名 / 等级 / 厚 / 宽 / 长 / 片数 = 10 */}
                <td colSpan={AFTER_LEAD_COLS} className="sheet-total-label">
                  合计
                </td>
                <td className="num">{formatCubic(afterCubic)}</td>
                <td>m³</td>
                {money && <td />}
                {money && <td className="num">{formatAmount(afterAmount)}</td>}
                <td />
              </tr>
              <tr>
                <td colSpan={AFTER_LEAD_COLS} className="sheet-total-label">
                  损耗（改后 − 改前）
                </td>
                <td className={lossCubic < 0 ? 'num is-short' : 'num'}>
                  {formatCubic(lossCubic)} {lossArrow}
                </td>
                <td>
                  {lossRate === null ? '—' : `${lossRate}% ${lossArrow}`}
                </td>
                {money && <td />}
                {money && (
                  <td className="num">
                    {formatAmount(roundTo(afterAmount - beforeAmount, 2))}
                  </td>
                )}
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
              {money && <th className="num">改前金额</th>}
              {money && <th className="num">改后金额</th>}
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
                {money && <td className="num">{formatAmount(row.before_amount)}</td>}
                {money && <td className="num">{formatAmount(row.after_amount)}</td>}
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
                  <div className="row-actions">
                    <button className="btn btn-sm" onClick={() => setViewTarget(row)}>
                      查看
                    </button>
                    <button className="btn btn-sm" onClick={() => void editRepack(row)}>
                      编辑
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={() => setUndoTarget(row)}>
                      撤销
                    </button>
                  </div>
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
              {money && <td className="num">{formatAmount(sums?.before_amount ?? 0)}</td>}
              {money && <td className="num">{formatAmount(sums?.after_amount ?? 0)}</td>}
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

      {/* 查看：只看这次的改前 / 改后，不动数据 */}
      {viewTarget && (
        <div className="overlay" onClick={() => setViewTarget(null)}>
          <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h2 className="modal-title">
                改包记录 {viewTarget.repack_no}
                {viewTarget.kind === 'split' ? '（拆包）' : '（改规格）'}
              </h2>
              <button className="btn btn-sm btn-quiet" onClick={() => setViewTarget(null)}>
                关闭
              </button>
            </div>

            <div className="meta">
              <span>日期：{viewTarget.repack_date}</span>
              <span>原包：{viewTarget.bale_no || '—'}（{viewTarget.barcode || '—'}）</span>
              <span>提单号：{viewTarget.bl_no || '—'}</span>
              <span>合同号：{viewTarget.contract_no || '—'}</span>
              <span>制单人：{viewTarget.created_by || '—'}</span>
            </div>

            <h3 className="section-title">改包前（1 包 · {formatCubic(viewTarget.before_cubic)} m³）</h3>
            {renderSpecTable(viewTarget.before_items)}

            <h3 className="section-title" style={{ marginTop: 22 }}>
              改包后（{viewTarget.bale_count} 包 · {formatCubic(viewTarget.after_cubic)} m³）
            </h3>
            {viewTarget.after_bales && viewTarget.after_bales.length > 0 ? (
              viewTarget.after_bales.map((group) => (
                <div key={group.bale_no || group.barcode} style={{ marginBottom: 18 }}>
                  <p className="muted" style={{ margin: '0 0 6px' }}>
                    包号 <b>{group.bale_no || '—'}</b>　条码号 {group.barcode || '—'}
                  </p>
                  {renderSpecTable(group.items)}
                </div>
              ))
            ) : (
              renderSpecTable(viewTarget.after_items)
            )}

            <div className="totals">
              <span>损耗：{formatCubic(viewTarget.loss_cubic)} m³</span>
              <span>
                损耗率：{viewTarget.loss_rate === null ? '—' : `${viewTarget.loss_rate}%`}
              </span>
            </div>
          </div>
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
                  <th className="num">厚度</th>
                  <th className="num">宽度</th>
                  <th className="num">长度</th>
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
                    {/*
                      混装包在这里必须走 length_text / pieces_text：
                      拿 row.length（只有第一段）和 row.pieces（片数合计）显示是错的
                    */}
                    <td className="num">{row.thickness}</td>
                    <td className="num">{row.width}</td>
                    <td className="num">{row.length_text ?? row.length}</td>
                    <td className="num">{row.pieces_text ?? row.pieces}</td>
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
