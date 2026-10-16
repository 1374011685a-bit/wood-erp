import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createRepack,
  fetchBaleDetail,
  fetchBales,
  deleteRepack,
  isBaleNoTakenError,
  fetchRepackBales,
  fetchRepackList,
  fetchDict,
  type BaleNoClash,
  type BaleRow,
  type RepackBale,
  type RepackLine,
  type RepackRow,
  type RepackSums,
} from '../api'
import { EmptyState, Loading, PageHead, Pager, ToastHost } from '../components/Ui'
import { toNumber, roundTo, formatCubic, formatAmount, todayISO } from '../utils/num'
import { tapFeedback } from '../utils/haptics'
import { useKeyboardScroll } from '../hooks/useKeyboardScroll'
import { useOnline } from '../hooks/useOnline'
import { isNetworkError } from '../utils/network'
import { readRecentSpecs, rememberSpecs, type RecentSpec } from '../utils/recentSpecs'
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
  /**
   * 这一行是哪个按钮铺出来的（只用于「保存前要不要再确认一次」，不参与分组、
   * 也不发给后端）：
   *   - `'split'`：「一键拆包」出来的 —— 用户已经明确表态要拆，保存时不再问
   *   - `'copy'`：「复制改包前数据」出来的 —— 意图不确定（可能想合并），
   *     多行又都留空包号时要确认一次「这会拆成 N 包」
   *   - 手填的行没有这个字段 → 和 `'copy'` 一样按「意图不确定」处理
   */
  fromAction?: 'split' | 'copy'
  /**
   * 这一行是从哪个源包搬过来的（「复制改包前数据」「一键拆包」自动带上，
   * 手填的行没有）。保存时发给后端，用来把这一行的账落回原本那张入库单。
   */
  srcBaleId?: number
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
 *   改包后：# 操作 旧包号 新包号 品牌 品名 等级 厚 宽 长 片数 立方 单位 [单价] [金额]
 */
const BEFORE_COLS = 14
const BEFORE_LEAD_COLS = 9
const AFTER_COLS = 15
const AFTER_LEAD_COLS = 11

/**
 * 改包记录列表里「改前 / 改后」那一列的文字：品牌/品名/等级 用「、」串起来。
 * 一串可能很长，列表里靠 CSS 截断 + `title` 悬停看全（见 `.repack-list .col-spec`）。
 */
const repackSpecText = (items: RepackLine[]) =>
  items
    .map(
      (line) =>
        `${line.brand ? `${line.brand}/` : ''}${line.species}` +
        `${line.grade ? `/${line.grade}` : ''}`,
    )
    .join('、') || '—'

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
  /** 选中的源包（多选）*/
  const [baleIds, setBaleIds] = useState<number[]>([])
  /** 弹窗里勾了几个（确认之前只是本地状态）*/
  const [pickerPicked, setPickerPicked] = useState<number[]>([])
  /**
   * 勾中的包「是哪一包」——**跨关键词、跨翻页都要记住**。
   *
   * ⚠️ 只存 id 是不够的：换关键词或翻页之后 `pickerRows` 换了，
   * 点「加进本次改包」时按 id 回去找会找不到 → 之前勾的包被静默丢掉
   * （用户以为选了两包，实际只加进去一包）。所以勾的时候连整行一起存下来。
   */
  const [pickerPickedRows, setPickerPickedRows] = useState<Record<number, BaleRow>>({})
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
  })
  const [saving, setSaving] = useState(false)
  /** 保存失败后可以「重试」的那一下 */
  const [retrySave, setRetrySave] = useState<null | (() => void)>(null)
  /** 离线时禁用保存 */
  const online = useOnline()
  // 默认进来看改包记录，点「新增改包」才进录入界面
  const [formOpen, setFormOpen] = useState(false)

  /** 键盘弹出来时把正在填的框顶到键盘上面（只在录入界面挂着） */
  useKeyboardScroll(formOpen)
  /** 常用规格（本机记的） */
  const [recentSpecs, setRecentSpecs] = useState<RecentSpec[]>(() => readRecentSpecs())
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
  /**
   * 撤销时「源包号被别的包占了」的冲突清单 + 用户当场填的新号。
   *
   * 只有后端回 409（`code: 'BALE_NO_TAKEN'`）时才有内容：这时候撤销弹窗
   * 不关，就地长出一排输入框让用户改号，改完带 `renames` 重发。
   */
  const [undoClashes, setUndoClashes] = useState<BaleNoClash[]>([])
  const [undoRenames, setUndoRenames] = useState<Record<number, string>>({})
  /**
   * 「改包后有多行、新包号却全留空」的保存确认。
   *
   * 这种表按规则会变成「一行 = 一包」（拆开），而不是用户想要的「合并」。
   * 仓管在「复制改包前数据」之后很容易忘了填包号直接保存，
   * 所以保存前弹一次确认，点确认才真提交。
   */
  const [splitConfirm, setSplitConfirm] = useState<{ count: number } | null>(null)
  /** 拆包确认框要不要带 force（从「确认丢弃」过来的时候要带下去） */
  const [splitForce, setSplitForce] = useState(false)
  /**
   * 「改包后总量比改包前少」的确认框。
   *
   * 只看总量，不逐行匹配 —— 改包本来就能合并行 / 拆行 / 改规格，
   * 逐行对会把合法操作误拦（用户把两行合成一行混装行是很常见的做法）。
   */
  const [discardConfirm, setDiscardConfirm] = useState<{ missing: number } | null>(null)
  /** 「查看」：只看这条改包的改前 / 改后明细，不改任何东西 */
  const [viewTarget, setViewTarget] = useState<RepackRow | null>(null)
  const [dict, setDict] = useState<{ species: string[]; grade: string[] }>({
    species: [],
    grade: [],
  })

  /**
   * 这次改包选中的源包（多选：1 个就是改这一包，多个就是合并 / 重排）。
   * `bales` 只是详情缓存；顺序按用户选的顺序来（第一个当"主包"）。
   */
  const pickedBales = useMemo(
    () => baleIds.map((id) => bales.find((item) => item.id === id)).filter((one): one is RepackBale => Boolean(one)),
    [baleIds, bales],
  )
  /** 兼容旧代码里的 `bale`：单选时就是那一包，多选时是第一个（只用于"要不要提示"这类判断） */
  const bale = pickedBales[0] ?? null

  /**
   * 新包会挂在哪张提单 / 哪个合同下 —— 只读提示用。
   *
   * 表单里已经没有这两个输入框（改包只做物理重组，归属由系统按来源自动挂），
   * 这里的算法和后端一致：来源一致就挂那一张；跨提单 / 跨合同合并就挂**第一个源包**那一张。
   */
  const pickedBlNos = useMemo(
    () => [...new Set(pickedBales.map((one) => (one.bl_no ?? '').trim()).filter(Boolean))],
    [pickedBales],
  )
  const pickedContractNos = useMemo(
    () => [...new Set(pickedBales.map((one) => (one.contract_no ?? '').trim()).filter(Boolean))],
    [pickedBales],
  )
  const attachBlNo =
    pickedBlNos.length > 1
      ? (bale?.bl_no ?? '').trim() || pickedBlNos[0]
      : (pickedBlNos[0] ?? '')
  const attachContractNo =
    pickedContractNos.length > 1
      ? (bale?.contract_no ?? '').trim() || pickedContractNos[0]
      : (pickedContractNos[0] ?? '')
  /** 跨提单合并：多张提单的货混进同一个包 */
  const isCrossShipment = pickedBlNos.length > 1

  /** 改包前的行：所有源包的行摊平，每行标上它来自哪个源包 */
  const beforeLines = useMemo(
    () =>
      pickedBales.flatMap((one) =>
        one.items.map((line) => ({
          ...line,
          srcBaleId: one.id,
          srcBaleNo: one.bale_no ?? '',
          srcBarcode: one.barcode ?? '',
        })),
      ),
    [pickedBales],
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
  const ambiguousCount = beforeLines.filter(
    (line) => line.id !== undefined && isPriceAmbiguous(line) && !beforePrices[line.id],
  ).length

  /** 改前总成本 = 每一行 立方 × 那一行的入库单价 */
  /** 成本价有歧义的行 —— 这些行还是要让用户逐行选，所以单独列在下面 */
  const ambiguousLines = beforeLines.filter(
    (line) => line.id !== undefined && isPriceAmbiguous(line),
  )

  const beforeCubic = useMemo(
    () => roundTo(beforeLines.reduce((sum, line) => sum + lineCubic(line), 0), 4),
    [beforeLines],
  )
  const beforeAmount = useMemo(
    () =>
      roundTo(
        beforeLines.reduce((sum, line) => sum + lineCubic(line) * beforePriceOf(line), 0),
        2,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [beforeLines, beforePrices],
  )

  /** 只要有一个源包是混装（多段）就允许「一键拆包」 */
  const isMixedBale = pickedBales.some((one) => one.items.length > 1)

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

  /**
   * 选货弹窗里勾中的包【追加】到源包列表（不清空已经选过的）。
   * 一包拉一次详情，并把 /api/repacks/bales 里的成本价候选并进来。
   */
  const addPickedBales = async (list: BaleRow[]) => {
    const fresh = list.filter((row) => !baleIds.includes(row.id))
    setPickerOpen(false)
    setPickerPicked([])
    setPickerPickedRows({})
    if (fresh.length === 0) return
    try {
      const details = await Promise.all(
        fresh.map((row) => fetchBaleDetail(row.id).then((full) => ({ row, full }))),
      )
      const added: RepackBale[] = []
      const ambiguous: Record<number, string> = {}
      for (const { row, full } of details) {
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
        added.push(asBale)
        for (const line of merged) {
          if (line.price_ambiguous && line.id !== undefined) ambiguous[line.id] = ''
        }
      }
      setBaleIds((prev) => [...prev, ...added.map((one) => one.id)])
      /**
       * 「改包后」默认留空 —— 系统不自作主张复制、也不自动拆。
       * 仓管自己选：复制改包前数据 / 一键拆包 / 手动加行。
       */
      setRows(blankRows())
      // 匹配到多个成本价的行先留空，等用户选（已经选过的保持原样）
      setBeforePrices((prev) => ({ ...prev, ...ambiguous }))
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取这一包失败')
    }
  }

  /** 从这次改包里移除一个源包 */
  const removePickedBale = (id: number) => {
    setBaleIds((prev) => prev.filter((one) => one !== id))
    setRows(blankRows())
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
   * 勾 / 取消勾一包：id 和整行一起记。
   * 换关键词、翻页都不会清这个记录 —— 只有「加进本次改包」或重新打开弹窗才清。
   */
  const togglePickerPick = (row: BaleRow, checked: boolean) => {
    setPickerPickedRows((prev) => {
      const next = { ...prev }
      if (checked) next[row.id] = row
      else delete next[row.id]
      return next
    })
    setPickerPicked((prev) =>
      checked ? [...new Set([...prev, row.id])] : prev.filter((id) => id !== row.id),
    )
  }

  /**
   * 复制改包前数据 = **每个源包一行**，原样搬过来：不拆、不改。
   *
   * 混装包搬过来仍然是斜杠串的一行（长度 1.8/2.1/2.4 配片数 17/30/247），
   * 新包号预填该源包的原包号 —— 源包马上要被删掉，可以沿用；保存下去就是"原样不动"。
   * （要按长度摊开成几包，用旁边那个「一键拆包（按长度）」。）
   */
  const copyBefore = () => {
    const next = pickedBales
      .filter((one) => one.items.length > 0)
      .map((one) => {
        const first = one.items[0]
        return {
          ...createRow(),
          fromAction: 'copy' as const,
          baleNo: one.bale_no ?? '',
          srcBaleId: one.id,
          brand: first.brand ?? '',
          species: first.species ?? '',
          grade: first.grade ?? '',
          thickness: String(first.thickness ?? ''),
          width: String(first.width ?? ''),
          length: one.items.map((line) => line.length).join('/'),
          pieces: one.items.map((line) => line.pieces).join('/'),
        }
      })
    if (next.length > 0) setRows(next)
  }

  const updateRow = (key: number, field: keyof AfterRow, value: string) => {
    setRows((prev) =>
      prev.map((row) => (row.key === key ? { ...row, [field]: value } : row)),
    )
  }

  /** ＋ 空白行：末尾加一行空的 */
  const addRow = () => setRows((prev) => [...prev, createRow()])

  /** 在指定行下面插一行空行（行内「+ 加行」按钮） */
  const insertRowAfter = (key: number) =>
    setRows((prev) => {
      const index = prev.findIndex((row) => row.key === key)
      if (index < 0) return [...prev, createRow()]
      const next = [...prev]
      next.splice(index + 1, 0, createRow())
      return next
    })

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
        // 复制的还是同一批货，「是从哪来的」跟着走（一键拆包的行复制出来也还是拆）
        fromAction: row.fromAction,
        // 复制本行 = 还是同一包来的货，来源跟着走
        srcBaleId: row.srcBaleId,
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

  /** 点「常用规格」：填进第一个还没写品名的行；都写满了就填最后一行 */
  const fillSpec = (spec: RecentSpec) => {
    tapFeedback()
    setRows((prev) => {
      const index = prev.findIndex((row) => !row.species.trim())
      const target = index >= 0 ? index : prev.length - 1
      return prev.map((row, i) =>
        i === target
          ? {
              ...row,
              species: spec.species,
              grade: spec.grade,
              thickness: spec.thickness,
              width: spec.width,
              length: spec.length,
            }
          : row,
      )
    })
  }

  /**
   * 一键拆包（按长度）：把**所有源包**的每一段规格各提成一行，包号留空。
   *
   * 手动触发，绝不自动跑；跑完结果摆在表里，用户可以改、可以删、可以再合并，
   * 不点保存什么都不算数。
   */
  const splitByLength = () => {
    /**
     * 一段规格 = 一行（包号留空 = 各自成包）；`srcBaleId` 记住它从哪一包来，
     * 保存时后端按这个把账落回原本那张入库单。
     * 不自动生成 P1/P2/P3 —— 包号是仓管从货上抄的，系统不替他编。
     */
    const next = pickedBales.flatMap((one) =>
      one.items.map((line) => ({
        ...rowFromLine(line),
        // 用户已经明确表态要拆，保存时不再问一次（见 handleSave 的确认条件）
        fromAction: 'split' as const,
        baleNo: '',
        srcBaleId: one.id,
      })),
    )
    if (next.length > 0) setRows(next)
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

  /**
   * 「多行 + 新包号全留空 + 不是一键拆包来的」—— 这种保存其实是在把货拆成 N 包。
   *
   * 仓管在「复制改包前数据」之后很容易忘了填包号直接保存，以为自己填的是"合并"，
   * 结果悄悄拆成了 N 包。所以这种情况要提醒 + 保存前确认一次。
   *
   * 「一键拆包」出来的行不算 —— 用户按那个按钮就是明确表态要拆，再问是啰嗦。
   */
  const needsSplitConfirm = (list: AfterRow[]) =>
    list.length > 1 &&
    list.every((row) => !row.baleNo.trim()) &&
    !list.some((row) => row.fromAction === 'split')

  const filledPreview = rows.filter((row) => row.species.trim())
  const allNosBlank = needsSplitConfirm(filledPreview)
  // 包号都空 = 一行一包，有几行就是几包
  const perRowGroupCount = allNosBlank ? filledPreview.length : 0


  const handleSave = async (continueAfter = false) => {
    setError('')
    if (baleIds.length === 0) {
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

    /**
     * 总量比改包前少 = 要丢货了。只比总量（改前总立方 vs 改后总立方），
     * 不逐行匹配规格 —— 合并行 / 拆行 / 改规格都是合法的。
     * 先弹确认（默认取消），点「确认丢弃」才带 force 提交。
     */
    if (willDiscard > 0.0001) {
      setDiscardConfirm({ missing: willDiscard })
      return
    }

    /**
     * 多行 + 新包号全留空 = 每行各自成一包（拆开），不是合并。
     * 保存前确认一次，避免仓管「想合并」却悄悄拆成了 N 包。
     * 「一键拆包」出来的行豁免（用户已经明确要拆）。
     */
    if (needsSplitConfirm(filled)) {
      setSplitForce(false)
      setSplitConfirm({ count: filled.length })
      return
    }

    await submitRepack(filled, false, continueAfter)
  }

  /**
   * 真正提交（确认框点「确认继续 / 确认丢弃」也走这里）。
   * `force` = 用户已经确认过「改包后总量比改包前少」，后端才放行。
   */
  const submitRepack = async (
    filled: AfterRow[],
    force = false,
    continueAfter = false,
  ) => {
    setSaving(true)
    try {
      const result = await createRepack({
        repack_date: form.repackDate,
        bale_ids: baleIds,
        summary: form.summary.trim(),
        remark: form.remark.trim(),
        ...(force ? { force: true } : {}),
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
            // 这一行从哪一包搬来的（手填的行没有）→ 后端据此把账落回原单
            ...(row.srcBaleId ? { srcBaleId: row.srcBaleId } : {}),
          })),
        })),
      })
      const split = (result.bale_count ?? 1) > 1
      const merged = baleIds.length > 1
      setNotice(
        split
          ? merged
            ? `已拆包 ${result.repack_no}：${baleIds.length} 个源包消失，重排成 ${result.bale_count} 个新包`
            : `已拆包 ${result.repack_no}：原包消失，拆成 ${result.bale_count} 个新包`
          : `已改包 ${result.repack_no}，库存已按新规格同步`,
      )
      setBaleIds([])
      setRows(blankRows())
      setBeforePrices({})
      // 记住这次的改后规格，下次点一下就填好
      setRecentSpecs(rememberSpecs(filled))
      setForm((prev) => ({ ...prev, summary: '', remark: '' }))
      if (continueAfter) {
        /**
         * 「保存并继续」：留在录入界面接着改下一包 ——
         * 选好的源包和改包后明细都清空（下一包得重新选货）。
         */
        setNotice(`已改包 ${result.repack_no}，可以接着改下一包`)
        window.setTimeout(() => window.scrollTo({ top: 0, behavior: 'smooth' }), 60)
      } else {
        setFormOpen(false)
      }
      setReloadToken((n) => n + 1)
    } catch (err) {
      // 网络层错误给人话 + 「重试」；业务错误原样展示
      if (isNetworkError(err)) {
        setError('网络不可用，请检查网络后重试')
        setRetrySave(() => () => void handleSave(continueAfter))
      } else {
        setError(err instanceof Error ? err.message : '改包失败')
        setRetrySave(null)
      }
    } finally {
      setSaving(false)
    }
  }

  /** 打开撤销弹窗（每次都把上一次的改号状态清干净） */
  const openUndo = (row: RepackRow) => {
    setUndoClashes([])
    setUndoRenames({})
    setUndoTarget(row)
  }

  const closeUndo = () => {
    setUndoTarget(null)
    setUndoClashes([])
    setUndoRenames({})
  }

  const confirmUndo = async () => {
    if (!undoTarget) return
    const renames: Record<number, string> = {}
    for (const [key, value] of Object.entries(undoRenames)) {
      renames[Number(key)] = value.trim()
    }
    try {
      await deleteRepack(undoTarget.id, Object.keys(renames).length > 0 ? renames : undefined)
      setNotice(
        undoTarget.kind === 'split'
          ? `已撤销拆包 ${undoTarget.repack_no}，拆出来的包已删掉，原包回来了`
          : `已撤销改包 ${undoTarget.repack_no}，这一包的规格回到改包前`,
      )
      closeUndo()
      setReloadToken((n) => n + 1)
    } catch (err) {
      /**
       * 源包号被别人占了：撤销弹窗**不关**，就地长出输入框让用户改号。
       * （以前这里只弹一句「包号 A3 已经存在，请换一个」就把弹窗关了，
       *   用户拿着这句提示无处下手，这条记录就永久卡死。）
       */
      if (isBaleNoTakenError(err) && err.payload?.clashes?.length) {
        const clashes = err.payload.clashes
        setUndoClashes(clashes)
        setUndoRenames((prev) => {
          const next = { ...prev }
          for (const clash of clashes) {
            // 第一次进入时预填原号，用户直接在上面改
            if (next[clash.bale_id] === undefined) next[clash.bale_id] = clash.bale_no
          }
          return next
        })
        setError(err.message)
        return
      }
      setError(err instanceof Error ? err.message : '撤销失败')
      closeUndo()
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
      const undone = await deleteRepack(row.id)
      setNotice(`已撤销 ${row.repack_no}，下面按这次的结果重新改一次，保存后会生成新记录`)
      setReloadToken((n) => n + 1)

      /**
       * 撤销之后源包回来了（多选改包可能有几个）。
       * 用撤销接口返回的 `restored_bales`（新 id）把它们重新选回来；
       * 老记录没有这个字段就退回用 `bale_id`。
       */
      const restoredIds = (undone.restored_bales ?? []).map((one) => one.id)
      const ids = restoredIds.length > 0 ? restoredIds : row.bale_id ? [row.bale_id] : []
      if (ids.length === 0) {
        setError('这条记录没有关联的包，无法编辑')
        return
      }
      const details = await Promise.all(ids.map((id) => fetchBaleDetail(id)))
      const asBales: RepackBale[] = details.map((full) => ({
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
        }))
      setBales((prev) => [
        ...prev.filter((one) => !asBales.some((b) => b.id === one.id)),
        ...asBales,
      ])
      setBaleIds(asBales.map((one) => one.id))
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
      }))
      setFormOpen(true)
    } catch (err) {
      /**
       * 「编辑」= 先撤销这条记录再重做。如果撤销那一步撞上「源包号被占用」，
       * 直接把撤销弹窗开出来让用户改号（改完撤销成功，点一次「编辑」就能继续）。
       * 不然这条记录在「编辑」这条路上同样是个死胡同。
       */
      if (isBaleNoTakenError(err) && err.payload?.clashes?.length) {
        const clashes = err.payload.clashes
        setUndoClashes(clashes)
        setUndoRenames(
          Object.fromEntries(clashes.map((clash) => [clash.bale_id, clash.bale_no])),
        )
        setUndoTarget(row)
        setError(err.message)
        return
      }
      setError(err instanceof Error ? err.message : '打开编辑失败')
    }
  }

  const lossCubic = roundTo(afterCubic - beforeCubic, 4)
  /** 总量比改包前少 = 要丢货（只比总量，不做逐行匹配） */
  const willDiscard = roundTo(beforeCubic - afterCubic, 4)
  const lossIsShort = willDiscard > 0.0001
  // 损耗率 = 损耗方数 ÷ 改前方数
  const lossRate = beforeCubic > 0 ? roundTo((lossCubic / beforeCubic) * 100, 2) : null
  const lossArrow = lossCubic > 0 ? '↑' : lossCubic < 0 ? '↓' : ''

  /** 查看弹窗里的一小块规格表（改前 / 改后共用） */
  const renderSpecTable = (items: RepackRow['after_items']) => {
    /**
     * 同一个包里的混装行（品名 / 等级 / 厚度 / 宽度一样，只有长度不同）合成一行：
     * 长度 / 片数写斜杠串 —— 和列表、改包页一个口径。
     * 合并范围限**同一个源包**（`src_bale_no`），否则多选改包时会把不同包的货串成一行。
     */
    const specKeyOf = (line: RepackLine) =>
      [line.src_bale_no ?? '', line.species, line.grade ?? '', line.thickness, line.width].join('|')
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
                onClose: () => {
                  setError('')
                  setRetrySave(null)
                },
                actionLabel: retrySave ? '重试' : undefined,
                onAction: retrySave ?? undefined,
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
          {/* 桌面端留在这里；手机端改用卡片外那份（见 .sheet-actions-fixed） */}
          <div className="sheet-actions sheet-actions-inline">
            {!online && <span className="action-offline-hint">请检查网络</span>}
            <button
              className="btn btn-primary"
              onClick={() => {
                tapFeedback()
                void handleSave()
              }}
              disabled={saving}
            >
              {saving && <span className="btn-spinner" aria-hidden="true" />}
              {saving ? '保存中…' : '保存'}
            </button>
            <button
              className="btn btn-continue"
              onClick={() => {
                tapFeedback()
                void handleSave(true)
              }}
              disabled={saving}
            >
              保存并继续
            </button>
            {/* 手机上「取消」和页头那个「返回改包记录」是同一个动作，两个入口都留着 */}
            <button className="btn" onClick={() => setFormOpen(false)}>
              取消
            </button>
          </div>
        </div>

        {/* 改包前：只读 */}
        <div className="sheet-toolbar">
          <span className="section-tag">改包前</span>
          <button
            className="btn btn-sm"
            onClick={() => {
              setPickerPicked([])
              setPickerPickedRows({})
              setPickerOpen(true)
            }}
          >
            选择货物
          </button>
          <span className="muted">
            {pickedBales.length > 0
              ? `已选 ${pickedBales.length} 包 · 合计 ${formatCubic(beforeCubic)} m³`
              : '还没选货'}
          </span>
          <span className="spacer" />
          <span className="muted">
            {pickedBales.length > 0
              ? `提单 ${
                  [...new Set(pickedBales.map((one) => one.bl_no || '—'))].join(' / ')
                }　合同 ${
                  [...new Set(pickedBales.map((one) => one.contract_no || '—'))].join(' / ')
                }`
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
          <table className="sheet-table sheet-repack-before">
            <thead>
              <tr>
                <th className="col-no">#</th>
                {/* 多选改包：这一行是从哪一包搬来的（同一包的行相邻排） */}
                <th>源包号</th>
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
              {pickedBales.length > 0 ? (
                <>
                {/*
                  多选时所有源包的规格行**平铺**：每行标「源包号」，同一包的行相邻排。
                  第一行旁边有个「移除」，把这一包从这次改包里拿掉。
                  长度 / 片数保持单值（一段一行）—— 混装包在库里本来就是一段一行，
                  要合成斜杠串是「改包后」那边的事。
                */}
                {beforeLines.map((line, index) => {
                  const isFirstOfBale =
                    index === 0 || beforeLines[index - 1].srcBaleId !== line.srcBaleId
                  return (
                    <tr key={`before-${line.srcBaleId}-${line.id ?? index}`}>
                      <td className="col-no">{index + 1}</td>
                      {/* 手机端：源包号 + 品名 一行，厚/宽/长 + 片数 + 立方 一行 */}
                      <td className="col-lead" data-label="源包号">
                        <span>{line.srcBaleNo || '—'}</span>
                        {isFirstOfBale && (
                          <button
                            type="button"
                            className="sheet-act sheet-act-danger"
                            style={{ marginLeft: 6 }}
                            title="把这一包从这次改包里移除"
                            onClick={() => removePickedBale(line.srcBaleId as number)}
                          >
                            ✕
                          </button>
                        )}
                      </td>
                      <td className="col-more" data-label="品牌">
                        {line.brand || '—'}
                      </td>
                      <td className="col-name-row" data-label="品名">
                        {line.species}
                      </td>
                      <td className="col-more" data-label="等级">
                        {line.grade || '—'}
                      </td>
                      <td className="col-tiny" data-label="厚度">
                        {line.thickness}
                      </td>
                      <td className="col-tiny" data-label="宽度">
                        {line.width}
                      </td>
                      <td className="col-tiny" data-label="长度">
                        {line.length}
                      </td>
                      <td className="col-qty" data-label="片数">
                        {line.pieces}
                      </td>
                      <td className="col-price num" data-label="立方 (m³)">
                        {formatCubic(lineCubic(line))}
                      </td>
                      <td className="col-more" data-label="单位">
                        m³
                      </td>
                      {money && <td className="num">{formatAmount(beforePriceOf(line))}</td>}
                      {money && (
                        <td className="num col-more" data-label="金额">
                          {formatAmount(lineCubic(line) * beforePriceOf(line))}
                        </td>
                      )}
                      <td className="col-code col-more" data-label="条码号">
                        {line.srcBarcode || '—'}
                      </td>
                    </tr>
                  )
                })}

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
        {/* 常用规格：手填新规格时点一下就填好（复制/拆包带出来的规格不用管） */}
        {recentSpecs.length > 0 && (
          <div className="spec-chips">
            <span className="spec-chips-label">常用规格</span>
            {recentSpecs.map((one) => (
              <button
                key={`${one.species}-${one.thickness}-${one.width}-${one.length}`}
                type="button"
                className="spec-chip"
                title={`把品名/等级/规格填成 ${one.species} ${one.thickness}×${one.width}×${one.length}`}
                onClick={() => fillSpec(one)}
              >
                {one.thickness}×{one.width}×{one.length}
                <em>{one.species}</em>
              </button>
            ))}
          </div>
        )}
        <div className="sheet-toolbar">
          <span className="section-tag">改包后</span>
          <button className="btn btn-sm" onClick={copyBefore} disabled={!bale}>
            复制改包前数据
          </button>
          {/* 只有混装包（一包多行规格）才需要拆，其余情况置灰并说明原因 */}
          <button
            className="btn btn-sm"
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

        {/*
          「复制改包前数据」出来多行、新包号又全留空 → 保存等于把货拆成 N 包。
          想合并的人容易漏填包号，这里常驻一句提醒（填了包号就自动消失）。
        */}
        {allNosBlank && (
          <p className="group-hint">
            注意：包号都留空 = 每行各自成一包（本次会拆成 {perRowGroupCount} 个独立包），
            <strong>不会合并</strong>。要合并请把它们填成同一个包号。
          </p>
        )}

        {/*
          新包挂哪张提单 / 哪个合同：**只读**（表单里没有这两个输入框）。
          改包只做物理重组，归属由系统按来源自动挂 —— 这一行就是告诉用户挂哪儿。
        */}
        {baleIds.length > 0 && (
          <div className="attach-hint">
            <p>
              本次改包后，新包将挂在 提单 <strong>{attachBlNo || '—'}</strong>、合同{' '}
              <strong>{attachContractNo || '—'}</strong> 下
            </p>
            {isCrossShipment && (
              <p className="muted">
                注意：这票包混合了多张提单的货，新包会挂在 提单 {attachBlNo || '—'} 下，
                其他提单的货会显示「货在别人的包里」。
              </p>
            )}
          </div>
        )}

        <div className="sheet-scroll">
          <table className="sheet-table sheet-repack-after">
            <thead>
              <tr>
                <th className="col-no">#</th>
                {/* 操作列放最左边（# 后面）：和入库 / 出库两张明细表位置一致 */}
                <th className="col-op">操作</th>
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
                    <td className="col-op">
                      <button
                        type="button"
                        className="sheet-act"
                        title="在这一行下面加一行空行"
                        onClick={() => insertRowAfter(row.key)}
                      >
                        + 加行
                      </button>
                      <button
                        type="button"
                        className="sheet-act"
                        title="复制本行（包号会清空，自己填）"
                        onClick={() => copyRow(row.key)}
                      >
                        复制
                      </button>
                      {/* title 挂在 span 上：按钮 disabled 时原生 tooltip 不弹，外面的包裹层还能弹 */}
                      <span
                        title={rows.length <= 1 ? '改包后至少要保留一行规格' : '删掉这一行'}
                      >
                        <button
                          type="button"
                          className="sheet-act sheet-act-danger"
                          disabled={rows.length <= 1}
                          onClick={() => removeRow(row.key)}
                        >
                          ✕ 删行
                        </button>
                      </span>
                    </td>
                    {/* 旧包号：这一行是从哪一包搬来的（手填的行没有 → 「—」） */}
                    <td className="col-more" data-label="旧包号">
                      {pickedBales.find((one) => one.id === row.srcBaleId)?.bale_no || '—'}
                    </td>
                    {/* 新包号：相同的算同一包；留空就是空的，系统不会替你编一个 */}
                    <td className="col-lead" data-label="新包号">
                      <input
                        className="sheet-input"
                        placeholder="可留空"
                        value={row.baleNo}
                        onChange={(event) => updateRow(row.key, 'baleNo', event.target.value)}
                      />
                    </td>
                    <td className="col-more" data-label="品牌">
                      <input
                        className="sheet-input"
                        value={row.brand}
                        onChange={(event) => updateRow(row.key, 'brand', event.target.value)}
                      />
                    </td>
                    <td className="col-name-row" data-label="品名 *">
                      <input
                        className="sheet-input"
                        list="repack-species"
                        value={row.species}
                        onChange={(event) => updateRow(row.key, 'species', event.target.value)}
                      />
                    </td>
                    <td className="col-more" data-label="等级">
                      <input
                        className="sheet-input"
                        list="repack-grade"
                        value={row.grade}
                        onChange={(event) => updateRow(row.key, 'grade', event.target.value)}
                      />
                    </td>
                    {(['thickness', 'width', 'length', 'pieces'] as const).map((field) => (
                      <td
                        key={field}
                        className={field === 'pieces' ? 'col-qty' : 'col-tiny'}
                        data-label={
                          field === 'thickness'
                            ? '厚'
                            : field === 'width'
                              ? '宽'
                              : field === 'length'
                                ? '长'
                                : '片数'
                        }
                      >
                        <input
                          className="sheet-input"
                          type="text"
                          inputMode="decimal"
                          placeholder={
                            field === 'thickness'
                              ? '厚'
                              : field === 'width'
                                ? '宽'
                                : field === 'length'
                                  ? '长'
                                  : '片数'
                          }
                          value={row[field]}
                          onChange={(event) => updateRow(row.key, field, event.target.value)}
                        />
                      </td>
                    ))}
                    <td className="col-more" data-label="立方 (m³)">
                      {cubic ? formatCubic(cubic) : ''}
                    </td>
                    <td className="col-more" data-label="单位">
                      {cubic ? 'm³' : ''}
                    </td>
                    {money && (
                      <td className="col-price" data-label="单价">
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
                      <td className="num col-more" data-label="金额">
                        {cubic ? formatAmount(cubic * priceOf(row)) : ''}
                      </td>
                    )}
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
              {/*
                损耗为负 = 改后总量比改前少（要丢货）→
                整行红底加粗 + ⚠，鼠标悬停说清丢了多少。
              */}
              <tr className={lossIsShort ? 'is-loss-warn' : undefined}>
                <td colSpan={AFTER_LEAD_COLS} className="sheet-total-label">
                  损耗（改后 − 改前）
                  {lossIsShort && (
                    <span
                      className="loss-warn-icon"
                      title={`本次改包丢弃了 ${formatCubic(willDiscard)} 方货`}
                    >
                      ⚠
                    </span>
                  )}
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

        {/*
          提单号 / 合同号输入框已经去掉（和千木云一样）：改包只做物理重组，
          归属由系统按来源自动挂 —— 结果在「改包后」上面那行只读提示里说明。
        */}
        <textarea
          className="input textarea sheet-note"
          placeholder="备注（选填）"
          value={form.remark}
          onChange={(event) => setForm((prev) => ({ ...prev, remark: event.target.value }))}
        />
        </div>
      )}

      {/* 手机端操作栏：放在卡片外面（iOS 上卡片内的 fixed 会被裁剪容器抓走，见 index.css） */}
      {formOpen && (
        <div className="sheet-actions sheet-actions-fixed">
          {!online && <span className="action-offline-hint">请检查网络</span>}
          <button
            className="btn btn-primary"
            onClick={() => {
              tapFeedback()
              void handleSave()
            }}
            disabled={saving || !online}
          >
            {saving && <span className="btn-spinner" aria-hidden="true" />}
            {saving ? '保存中…' : '保存'}
          </button>
          <button
            className="btn btn-continue"
            onClick={() => {
              tapFeedback()
              void handleSave(true)
            }}
            disabled={saving || !online}
          >
            保存并继续
          </button>
          <button className="btn" onClick={() => setFormOpen(false)}>
            取消
          </button>
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

        {/*
          改包记录列表：**只出现在这个列表里**的紧凑列 —— 原来 17 列、1945px，
          1366 屏下要横滑 893px 才看得到操作按钮。这里按「合并同类项」压到 12 列：
            · 改前立方 / 改后立方 / 损耗 / 损耗率  → 「立方」+「损耗」两列
            · 改前金额 / 改后金额                  → 「金额」一列
            · 摘要 / 制单人                        → 移进「查看」弹窗（列表里用不着留痕字段）
            · 改前 / 改后 的品名串                → 截断 + 悬停看全（title）
          列一多就必须横滑，而这些"改前改后并排"的信息用 `3 → 3` 表示反而更好读。
        */}
        <table className="table repack-list">
          <thead>
            <tr>
              <th>日期</th>
              <th>单号</th>
              <th>源包号</th>
              <th>包数</th>
              <th>条码号</th>
              <th>提单号</th>
              <th className="col-spec">改前</th>
              <th className="col-spec">改后</th>
              <th className="num">立方 (m³)</th>
              {money && <th className="num">金额 (元)</th>}
              <th className="num">损耗</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {list.map((row) => (
              <tr key={row.id}>
                <td>{row.repack_date}</td>
                <td>{row.repack_no}</td>
                <td>
                  {(row.source_bale_nos ?? []).length > 0
                    ? (row.source_bale_nos ?? []).join('、')
                    : row.bale_no || '—'}
                </td>
                <td className="num">
                  {row.source_bale_count ?? 1} → {row.bale_count}
                </td>
                <td>{row.barcode || '—'}</td>
                <td>{row.bl_no || '—'}</td>
                {/* 品名串可能很长，列里截断显示，鼠标悬停看全文 */}
                <td className="col-spec" title={repackSpecText(row.before_items)}>
                  {repackSpecText(row.before_items)}
                </td>
                <td className="col-spec" title={repackSpecText(row.after_items)}>
                  {repackSpecText(row.after_items)}
                </td>
                {/* 四列并一列：立方 3 → 3 */}
                <td className="num">
                  {formatCubic(row.before_cubic)} → {formatCubic(row.after_cubic)}
                </td>
                {money && (
                  <td className="num">
                    {formatAmount(row.before_amount)} → {formatAmount(row.after_amount)}
                  </td>
                )}
                {/* 损耗 + 损耗率并一列 */}
                <td className={row.loss_cubic < 0 ? 'num is-short' : 'num'}>
                  {formatCubic(row.loss_cubic)}
                  {row.loss_cubic > 0 ? ' ↑' : row.loss_cubic < 0 ? ' ↓' : ''}
                  {' · '}
                  {row.loss_rate === null ? '—' : `${row.loss_rate}%`}
                </td>
                <td>
                  <div className="row-actions">
                    <button className="btn btn-sm" onClick={() => setViewTarget(row)}>
                      查看
                    </button>
                    <button className="btn btn-sm" onClick={() => void editRepack(row)}>
                      编辑
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={() => openUndo(row)}>
                      撤销
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              {/* 领先列：日期 / 单号 / 源包号 / 包数 / 条码号 / 提单号 / 改前 / 改后 = 8 */}
              <td colSpan={8} className="sheet-total-label">
                合计
              </td>
              {/* 立方：改前 → 改后（原来拆成两列） */}
              <td className="num">
                {formatCubic(sums?.before_cubic ?? 0)} → {formatCubic(sums?.after_cubic ?? 0)}
              </td>
              {/* 金额：改前 → 改后（原来拆成两列） */}
              {money && (
                <td className="num">
                  {formatAmount(sums?.before_amount ?? 0)} → {formatAmount(sums?.after_amount ?? 0)}
                </td>
              )}
              {/* 损耗（损耗率那列已经并进这一列，合计行只给方数） */}
              <td className="num">{formatCubic(sums?.loss_cubic ?? 0)}</td>
              {/* 操作 */}
              <td />
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
                {viewTarget.kind === 'split'
                  ? (viewTarget.source_bale_count ?? 1) > 1
                    ? `（${viewTarget.source_bale_count} 包 → ${viewTarget.bale_count} 包）`
                    : `（拆包 ${viewTarget.bale_count} 包）`
                  : '（改规格）'}
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

            <h3 className="section-title">
              改包前（{viewTarget.source_bale_count ?? 1} 包
              {(viewTarget.source_bale_nos ?? []).length > 0
                ? `：${(viewTarget.source_bale_nos ?? []).join('、')}`
                : ''}
              　· {formatCubic(viewTarget.before_cubic)} m³）
            </h3>
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

      {/*
        改包后总量比改包前少 = 要丢货。
        默认「取消」（按钮自动聚焦，回车也是取消），点「确认丢弃」才带 force 保存。
      */}
      {discardConfirm && (
        <div className="overlay" onClick={() => setDiscardConfirm(null)}>
          <div
            className="modal modal-narrow modal-alert"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="modal-title">注意：改包后总量变少了</h2>
            <p className="confirm-text">
              本次改包后总量比改包前少 <strong>{formatCubic(discardConfirm.missing)} 方</strong>，
              <br />
              确认要丢掉这些货吗？
            </p>
            <div className="confirm-actions">
              <button className="btn" autoFocus onClick={() => setDiscardConfirm(null)}>
                取消
              </button>
              <button
                className="btn btn-danger-solid"
                onClick={() => {
                  const filled = rows.filter((row) => row.species.trim())
                  setDiscardConfirm(null)
                  if (needsSplitConfirm(filled)) {
                    setSplitForce(true)
                    setSplitConfirm({ count: filled.length })
                    return
                  }
                  // 用户已经确认「要丢掉这些货」→ 带 force，后端才放行
                  void submitRepack(filled, true)
                }}
              >
                确认丢弃
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 多行 + 新包号全空：保存前再确认一次「会拆成 N 包」 */}
      {splitConfirm && (
        <div className="overlay" onClick={() => setSplitConfirm(null)}>
          <div
            className="modal modal-narrow modal-alert"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="modal-title">包号都留空了</h2>
            <p className="confirm-text">
              本次会把 {splitConfirm.count} 行拆成 {splitConfirm.count} 个独立包（每行一包），
              <strong>不是合并</strong>。
              <br />
              确认继续？
            </p>
            <div className="confirm-actions">
              <button className="btn" onClick={() => setSplitConfirm(null)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setSplitConfirm(null)
                  // 重新按当前表格取一遍行，走同一条提交路径
                  void submitRepack(rows.filter((row) => row.species.trim()), splitForce)
                }}
              >
                确认继续
              </button>
            </div>
          </div>
        </div>
      )}

      {undoTarget && (
        <div className="overlay" onClick={closeUndo}>
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

            {/*
              源包号被别人占了：不关弹窗，就地让用户改号。
              后端把冲突清单（哪个源包的哪个号被占了）一起带回来，
              这里一个号一个输入框，改完点「改号并撤销」带着新号重发。
            */}
            {undoClashes.length > 0 && (
              <div className="undo-clash">
                <p className="undo-clash-tip">
                  撤销要把原包重建回来，但下面这些包号现在被别人占着（包号全局唯一）。
                  给它们换个号就能撤销；留空 = 不要包号。
                </p>
                {undoClashes.map((clash) => (
                  <label key={clash.bale_id} className="undo-clash-row">
                    <span className="undo-clash-label">
                      原包号 {clash.original_bale_no || '（空）'}
                      {clash.reason === 'duplicate' ? ' · 和上面的新号重了' : ' · 已被占用'}
                    </span>
                    <input
                      className="input"
                      value={undoRenames[clash.bale_id] ?? ''}
                      placeholder="改成别的包号（留空 = 不要包号）"
                      onChange={(event) =>
                        setUndoRenames((prev) => ({ ...prev, [clash.bale_id]: event.target.value }))
                      }
                    />
                  </label>
                ))}
              </div>
            )}

            <div className="confirm-actions">
              <button className="btn" onClick={closeUndo}>
                取消
              </button>
              <button className="btn btn-danger-solid" onClick={() => void confirmUndo()}>
                {undoClashes.length > 0 ? '改号并撤销' : '确认撤销'}
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
                className="input input-wide"
                placeholder="包号 / 品名 / 等级 / 柜号 / 提单号"
                title="包号 / 品名 / 等级 / 柜号 / 提单号"
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
              <span className="muted">
                共 {pickerTotal} 包 · 勾选后点右边「加进本次改包」
              </span>
              <button
                className="btn btn-primary"
                onClick={() =>
                  /**
                   * 按「勾选的先后」加进去（用户先勾的那包排在前面，第一个当主包）。
                   * 用 pickerPickedRows（勾的时候连行一起存下来的）而不是去 pickerRows 里找 ——
                   * 翻页 / 换关键词之后 pickerRows 已经变了，按 id 找会把早先勾的包丢掉。
                   */
                  void addPickedBales(
                    pickerPicked
                      .map((id) => pickerPickedRows[id])
                      .filter((one): one is BaleRow => Boolean(one)),
                  )
                }
                disabled={pickerPicked.length === 0}
              >
                加进本次改包（{pickerPicked.length}）
              </button>
            </div>

            <table className="table">
              <thead>
                <tr>
                  <th className="col-check">
                    <input
                      type="checkbox"
                      checked={
                        pickerRows.length > 0 &&
                        pickerRows.every((one) => pickerPicked.includes(one.id))
                      }
                      onChange={(event) =>
                        pickerRows.forEach((one) =>
                          togglePickerPick(one, event.target.checked),
                        )
                      }
                    />
                  </th>
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
                </tr>
              </thead>
              <tbody>
                {pickerRows.map((row) => {
                  const already = baleIds.includes(row.id)
                  return (
                  <tr key={row.id} className={already ? 'row-active' : undefined}>
                    <td className="col-check">
                      <input
                        type="checkbox"
                        disabled={already}
                        title={already ? '这一包已经在下面了' : '勾选，然后点右上角「加进本次改包」'}
                        checked={already || pickerPicked.includes(row.id)}
                        onChange={(event) => togglePickerPick(row, event.target.checked)}
                      />
                    </td>
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
                  </tr>
                  )
                })}
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
