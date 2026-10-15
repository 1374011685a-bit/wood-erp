import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useEscapeKey } from '../hooks/useEscapeKey'
import {
  createInbound,
  deleteInbound,
  downloadFile,
  fetchInboundDetail,
  fetchInboundByBlNo,
  fetchInboundList,
  isBlHasOrderError,
  fetchContractOptions,
  fetchContractPicker,
  checkBaleNo,
  fetchShipmentOptions,
  fetchDict,
  openContractFile,
  fetchStockList,
  inboundExportUrl,
  updateInbound,
  type ContractOption,
  type ContractPickerRow,
  type ShipmentOption,
  type DictAll,
  type InboundDetail,
  type InboundDetailItem,
  type InboundItemPayload,
  type InboundListFilters,
  type InboundListItem,
} from '../api'
import {
  EmptyState,
  Loading,
  PageHead,
  Pager,
  PullIndicator,
  TableSkeleton,
  ToastHost,
} from '../components/Ui'
import { toNumber, roundTo, formatCubic, formatAmount, todayISO } from '../utils/num'
import { tapFeedback } from '../utils/haptics'
import { usePullToRefresh } from '../hooks/usePullToRefresh'
import { useKeyboardScroll } from '../hooks/useKeyboardScroll'
import { readRecentSpecs, rememberSpecs, type RecentSpec } from '../utils/recentSpecs'
import { useRole } from '../hooks/useRole'
import { seesMoney } from '../permissions'
import { can } from '../permissions'

/* ---------- 立方预览：与 server/utils/cubic.js 同一公式 ---------- */

const CUBIC_DIVISOR = 1000000

/**
 * 混装包：一行里长度/片数可以用斜杠写多段（1800/2100/2400 + 17/30/247）。
 *
 * 这里和服务端 server/utils/slashSpecs.js 是同一套口径：
 *   - 段数必须一致，只有一边有斜杠算错
 *   - 长度大于 20 当毫米（1800 → 1.8m）
 * 返回空数组表示这一行不是多段写法，按普通行处理。
 */
function slashSegments(row: FormRow): { meters: number; pieces: number }[] {
  const lenText = row.length.trim()
  const pcsText = row.pieces.trim()
  if (!lenText.includes('/') && !pcsText.includes('/')) return []

  const lens = lenText ? lenText.split('/').map((one) => one.trim()) : []
  const pcss = pcsText ? pcsText.split('/').map((one) => one.trim()) : []
  if (lens.length !== pcss.length) return []

  return lens.map((one, index) => {
    const num = toNumber(one)
    return {
      meters: num > 20 ? num / 1000 : num,
      pieces: toNumber(pcss[index]),
    }
  })
}

/** 一行（可能是多段）的立方合计 */
const previewCubic = (row: FormRow) => {
  const segments = slashSegments(row)
  const bundles = toNumber(row.bundles)
  if (segments.length === 0) {
    return roundTo(
      (toNumber(row.thickness) *
        toNumber(row.width) *
        toNumber(row.length) *
        toNumber(row.pieces) *
        bundles) /
        CUBIC_DIVISOR,
      4,
    )
  }
  const perBundle = segments.reduce(
    (sum, seg) =>
      sum + (toNumber(row.thickness) * toNumber(row.width) * seg.meters * seg.pieces) / CUBIC_DIVISOR,
    0,
  )
  return roundTo(perBundle * (bundles || 1), 4)
}

const previewAmount = (cubic: number, unitPrice: string) =>
  roundTo(cubic * toNumber(unitPrice), 2)

/* ---------- 明细行 ---------- */

type FormRow = {
  key: number
  /** 柜号：这包货装在哪个柜/柜里 */
  boxNo: string
  /** 品牌（选填）：只记不参与匹配 */
  brand: string
  /** 包号（=码单号）：留空由系统自动编号；混装包时手动填同一个号 */
  baleLabel: string
  /** 「同包再加一行」：这一行是往上一行那个包里再加一个规格 */
  species: string
  grade: string
  thickness: string
  width: string
  length: string
  pieces: string
  bundles: string
  unitPrice: string
}

let rowSeq = 0

const createRow = (): FormRow => ({
  key: (rowSeq += 1),
  baleLabel: '',
  boxNo: '',
  brand: '',
  species: '',
  grade: '',
  thickness: '',
  width: '',
  length: '',
  pieces: '',
  bundles: '',
  unitPrice: '',
})

/** 表格里始终铺满 MIN_SHEET_ROWS 行空行，点进去就能填 */
const padRows = (list: FormRow[]) => {
  const next = [...list]
  const floor = sheetRowFloor()
  while (next.length < floor) next.push(createRow())
  return next
}

const isRowEmpty = (row: FormRow) =>
  !row.baleLabel.trim() &&
  !row.boxNo.trim() &&
  !row.brand.trim() &&
  !row.species.trim() &&
  !row.grade.trim() &&
  !row.thickness.trim() &&
  !row.width.trim() &&
  !row.length.trim() &&
  !row.unitPrice.trim()

// 规格键：与后端 品名+等级+厚度+宽度+长度 归组口径一致
const specKeyOf = (row: FormRow) => {
  const species = row.species.trim()
  const thickness = toNumber(row.thickness)
  const width = toNumber(row.width)
  const length = toNumber(row.length)
  if (!species || thickness <= 0 || width <= 0 || length <= 0) return ''
  return [species, row.grade.trim(), thickness, width, length].join('|')
}

/* ---------- 明细字段校验：与 server/utils/validateItems.js 同一套规则 ---------- */

const MAX_THICKNESS = 1000 // mm
const MAX_WIDTH = 1000 // mm
const MAX_LENGTH = 20 // m

function validateRow(row: FormRow): string[] {
  const reasons: string[] = []
  const thickness = toNumber(row.thickness)
  const width = toNumber(row.width)
  const length = toNumber(row.length)
  const pieces = toNumber(row.pieces)
  const bundles = toNumber(row.bundles)

  if (!row.species.trim()) reasons.push('品名不能为空')

  if (thickness <= 0) reasons.push('厚度必须大于 0mm')
  else if (thickness > MAX_THICKNESS) reasons.push(`厚度不能超过 ${MAX_THICKNESS}mm`)

  if (width <= 0) reasons.push('宽度必须大于 0mm')
  else if (width > MAX_WIDTH) reasons.push(`宽度不能超过 ${MAX_WIDTH}mm`)

  /**
   * 长度 / 片数支持斜杠多段（混装包）。
   * 段数不等、或者只有一边有斜杠 —— 当场报错，不做任何猜测。
   */
  const lenText = row.length.trim()
  const pcsText = row.pieces.trim()
  const lenHasSlash = lenText.includes('/')
  const pcsHasSlash = pcsText.includes('/')

  if (thickness !== toNumber(row.thickness) && String(row.thickness).includes('/')) {
    reasons.push('厚度只能填一个数')
  }
  if (String(row.width).includes('/')) reasons.push('宽度只能填一个数')

  if (lenHasSlash !== pcsHasSlash) {
    reasons.push('长度和片数要么都只有一段，要么都用「/」写同样多段（如 1800/2100/2400 配 17/30/247）')
  } else if (lenHasSlash) {
    const segments = slashSegments(row)
    if (segments.length === 0) {
      reasons.push('长度和片数的段数要一样多，请检查斜杠写法')
    } else {
      segments.forEach((seg, index) => {
        if (!(seg.meters > 0)) reasons.push(`第 ${index + 1} 段长度必须大于 0m`)
        else if (seg.meters > MAX_LENGTH) {
          reasons.push(`第 ${index + 1} 段长度不能超过 ${MAX_LENGTH}m`)
        }
        if (!(Number.isInteger(seg.pieces) && seg.pieces > 0)) {
          reasons.push(`第 ${index + 1} 段片数必须是大于 0 的整数`)
        }
      })
    }
  } else {
    if (length <= 0) reasons.push('长度必须大于 0m')
    else if (length > MAX_LENGTH) reasons.push(`长度不能超过 ${MAX_LENGTH}m`)
    if (!(Number.isInteger(pieces) && pieces > 0)) reasons.push('片数必须是大于 0 的整数')
  }

  if (!(Number.isInteger(bundles) && bundles > 0)) reasons.push('件数必须是大于 0 的整数')
  if (!(toNumber(row.unitPrice) > 0)) reasons.push('单价必填，且必须大于 0')

  return reasons
}

// 整行留空的行会被忽略、不提交，因此也不参与校验
function validateRows(rows: FormRow[]): Record<number, string[]> {
  const errors: Record<number, string[]> = {}
  // 同一批里包号重复也要当场提示（同一个包号只能出现一次，
  // 想往一包里再加规格，用「同包再加一行」）
  const seen = new Map<string, number>()
  for (const row of rows) {
    if (isRowEmpty(row)) continue
    const reasons = validateRow(row)
    const label = row.baleLabel.trim()
    if (label) {
      for (const one of parseBaleLabels(label)) {
        const firstKey = seen.get(one)
        if (firstKey !== undefined && firstKey !== row.key) {
          reasons.push(`包号 ${one} 在这一批里重复了，请换一个包号`)
          break
        }
        if (firstKey === undefined) seen.set(one, row.key)
      }
    }
    if (reasons.length > 0) errors[row.key] = reasons
  }
  return errors
}

const emptyFilters: InboundListFilters = {}

/**
 * 解析包号输入：
 * - 单个：`7`
 * - 连续范围：`7-9` → 7、8、9
 * - 多个：`7,9,11`
 * 留空则由系统按提单内顺序自动编号。
 */
function parseBaleLabels(text: string): string[] {
  const value = text.trim()
  if (!value) return []

  const result: string[] = []
  for (const part of value.split(/[,，、;；\s]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/)
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])]
      if (to >= from && to - from <= 500) {
        for (let i = from; i <= to; i += 1) result.push(String(i))
        continue
      }
    }
    result.push(part)
  }
  return result
}

/* ---------- 条码号（=要打印贴包上的那张码）：显示规则与后端 buildBaleNo 一致 ---------- */

const padBaleSeq = (seq: number) => String(seq).padStart(3, '0')

const emptyInput = {
  order_no: '',
  supplier: '',
  warehouse: '',
  operator: '',
  date_from: '',
  date_to: '',
}

const PAGE_SIZE = 20
const PICKER_PAGE_SIZE = 20
/** 表格里一直留这么多空行，点进去就能填（和千木云一样） */
const MIN_SHEET_ROWS = 10
/** 手机上卡片一行很高，少铺几行，要用「+」自己加 */
const MIN_SHEET_ROWS_MOBILE = 4
const sheetRowFloor = () =>
  typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches
    ? MIN_SHEET_ROWS_MOBILE
    : MIN_SHEET_ROWS

/* ---------- 样式 ---------- */


type RowField =
  | 'baleLabel'
  | 'boxNo'
  | 'brand'
  | 'species'
  | 'grade'
  | 'thickness'
  | 'width'
  | 'length'
  | 'pieces'
  | 'bundles'

/**
 * 可输入列。
 *
 * `label` 尽量短（表头改成 `white-space: nowrap` 之后，表头文字宽度直接决定列宽，
 * 太长会把整张表顶宽）；说不完的提示放 `hint`，渲染成 `title` 兜底。
 */
const rowFields: { field: RowField; label: string; hint?: string }[] = [
  { field: 'baleLabel', label: '包号' },
  { field: 'boxNo', label: '柜号' },
  { field: 'brand', label: '品牌' },
  { field: 'species', label: '品名 *' },
  { field: 'grade', label: '等级' },
  { field: 'thickness', label: '厚度 (mm)' },
  { field: 'width', label: '宽度 (mm)' },
  // 混装包：这两个都能用「/」写多段（1800/2100/2400 配 17/30/247）
  { field: 'length', label: '长度 (m)', hint: '可多段：混装包写 1.8/2.1/2.4' },
  { field: 'pieces', label: '片数 (片)', hint: '可多段：混装包写 17/30/247' },
  { field: 'bundles', label: '件数 (件)' },
]

/**
 * 手机端明细行的排布（只在 <768px 生效，桌面那张宽表不受影响）。
 *
 *   col-wide  独占一行的字段（包号、品名 —— 值比较长）
 *   col-third 一行放三个的字段（等级/厚/宽/长/片数/件数/单价，值都是短数字）
 *   col-more  默认收起的次要字段（柜号/品牌/数量/单位/金额/条码号），点「更多」才展开
 *
 * 桌面端这些类名一个都不参与样式，所以 PC 那张表还是老样子。
 */
const FIELD_COL_CLASS: Partial<Record<RowField, string>> = {
  baleLabel: 'col-wide',
  boxNo: 'col-more',
  brand: 'col-more',
  species: 'col-wide',
  grade: 'col-third',
  thickness: 'col-third',
  width: 'col-third',
  length: 'col-third',
  pieces: 'col-third',
  bundles: 'col-third',
}

/**
 * 手机端的短字段名（一行三个时，「厚度 (mm)」这种长名字会把输入框挤没）。
 * 桌面的表头保持完整叫法 —— 这只是给手机卡片上的 label 用。
 */
const FIELD_SHORT_LABEL: Partial<Record<RowField, string>> = {
  thickness: '厚',
  width: '宽',
  length: '长',
  pieces: '片数',
  bundles: '件数',
}

/**
 * 明细里哪些字段是**文本**（要弹全键盘）。
 *
 * ⚠️ 包号 / 柜号 / 品牌必须是文本：包号能写「P1、P2、P3」这种范围，
 * 品牌是中文名 —— 这几个之前被当成数字字段，手机上弹的是数字键盘，字母打不出来。
 */
const TEXT_FIELDS: RowField[] = ['baleLabel', 'boxNo', 'brand', 'species', 'grade']

/** 明细表固定列：序号 / 勾选 / 操作 */
const SHEET_LEAD_COLS = 3
/** 明细表固定列：数量(m³) / 单位 / 单价(元)* / 金额(元) / 条码号 */
const SHEET_TAIL_COLS = 5
/**
 * 明细表总列数 = 固定列 + 可输入列（rowFields）。
 * 合计行不再写死 colspan，一律从总列数倒推——以后往 rowFields 里加列也不会再错位。
 */
const SHEET_COL_COUNT = SHEET_LEAD_COLS + rowFields.length + SHEET_TAIL_COLS

/**
 * 详情页「入库明细」的显示行。
 *
 * 混装包在库里是**一段规格一行**（写库存必须按段），但界面上它是一包一行：
 * 同一个包号的那几段合成一行，长度 / 片数写斜杠串（1.8/2.1/2.4、17/30/247）。
 * 包号为空的散货行分不清是不是同一包，保持一行一段。
 */
const mergeItemsByBale = (items: InboundDetailItem[]) => {
  const groups: InboundDetailItem[][] = []
  const byBaleNo = new Map<string, InboundDetailItem[]>()

  for (const item of items) {
    const no = String(item.bale_no ?? '').trim()
    if (!no) {
      groups.push([item])
      continue
    }
    const hit = byBaleNo.get(no)
    if (hit) {
      hit.push(item)
      continue
    }
    const group = [item]
    byBaleNo.set(no, group)
    groups.push(group)
  }

  return groups
}

export default function Inbound({
  defaultMode = 'list',
}: {
  /**
   * /inbound 走「先选入库方式」，/inbound/records 直接看记录，
   * /inbound/edit/:id 直接把那张单打开成编辑状态。
   */
  defaultMode?: 'method' | 'list' | 'edit'
}) {
  const navigate = useNavigate()
  const { id: editIdParam } = useParams()
  /**
   * 看不到金额的角色（业务员 / 仓管）：
   *   - 明细表的「金额(元)」列、合计里的金额、详情弹窗的单价/金额都不显示；
   *   - 「单价(元)」输入框**保留** —— 方案 A：录单的人得自己填；
   *   - 改单时前端拿不到原价，后端会把对得上的行原价补回去，不会清成 0。
   * 明细总列数跟着少一列，合计行的 colspan 是从列数倒推的，这里必须一起改。
   */
  const money = seesMoney(useRole())
  /** 只读角色不给「新增 / 编辑 / 删除」的入口：后端也会 403，但按钮摆着点了必然失败 */
  const canWrite = can(useRole(), 'inbound.write')

  /**
   * 'edit' 只是"从 /inbound/edit/:id 进来"的标记：初始显示列表，
   * 挂载后由 useEffect 把那张单拉出来打开成编辑态（所以初始化成 'list'）。
   */
  const [mode, setMode] = useState<'method' | 'list' | 'create'>(
    defaultMode === 'edit' ? 'list' : defaultMode,
  )
  // 入库方式：直接入库 / 关联采购合同
  const [method, setMethod] = useState<'direct' | 'contract'>('direct')
  const [pickedContract, setPickedContract] = useState<ContractPickerRow | null>(null)
  // 选合同大页面
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerKeyword, setPickerKeyword] = useState('')
  const [pickerRows, setPickerRows] = useState<ContractPickerRow[]>([])
  const [pickerTotal, setPickerTotal] = useState(0)
  const [pickerOffset, setPickerOffset] = useState(0)
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerError, setPickerError] = useState('')
  const [pickerPick, setPickerPick] = useState<ContractPickerRow | null>(null)
  // 非空 = 正在修改这张单（单号不变，只替换明细）
  const [editing, setEditing] = useState<{ id: number; order_no: string } | null>(null)
  /** 保存时后端回「这个提单号已经有活单」→ 弹窗让用户选追加还是仍要新建 */
  const [blConflict, setBlConflict] = useState<{
    message: string
    order: { id: number; order_no: string; cubic: number } | null
  } | null>(null)
  /**
   * 老单据标记：这张单入库时提单号还不是必填，库里存的就是空。
   * 这种单允许继续空着保存（新建仍然必填），不然它就永远改不了了。
   */
  const [legacyNoBl, setLegacyNoBl] = useState(false)

  const [list, setList] = useState<InboundListItem[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState('')
  const [notice, setNotice] = useState('')

  const [input, setInput] = useState(emptyInput)
  const [filters, setFilters] = useState<InboundListFilters>(emptyFilters)
  /** 手机端：筛选字段收进底部 sheet（桌面端还是平铺一行） */
  const [filterOpen, setFilterOpen] = useState(false)
  /** 手机端：表单里「更多信息」（操作员 / 柜数）是否展开 */
  const [moreOpen, setMoreOpen] = useState(false)
  /** 常用规格（本机记的，最近用过的排在前面） */
  const [recentSpecs, setRecentSpecs] = useState<RecentSpec[]>(() => readRecentSpecs())
  /** 手机端左滑：露出「编辑 / 移入回收站」（一次只开一行） */
  const [swipedId, setSwipedId] = useState<number | null>(null)
  const swipeStartX = useRef(0)
  /** 「筛选」按钮上的角标：当前生效了几个筛选条件（不含单号关键字） */
  const activeFilterCount = [
    filters.supplier,
    filters.warehouse,
    filters.operator,
    filters.date_from,
    filters.date_to,
  ].filter(Boolean).length

  /** 手机端下拉刷新：拉一下重新拉当前筛选条件的列表 */
  const { distance: pullDistance, busy: pullBusy } = usePullToRefresh(
    () => loadList(filters, offset),
    mode === 'list',
  )

  /** 键盘弹出来时把正在填的框顶到键盘上面（手机上录单必需） */
  useKeyboardScroll(mode !== 'list')
  const [offset, setOffset] = useState(0)
  const [total, setTotal] = useState(0)
  // 每次增删改后 +1，强制重新拉列表（避免「筛选没变就不刷新」）
  const [reloadToken, setReloadToken] = useState(0)
  // 合同下拉选项（填合同号时给提示，不强制）
  const [contractOptions, setContractOptions] = useState<ContractOption[]>([])
  // 提单（这批到货）：选了提单，合同号/提单号直接从提单上带出来
  const [shipmentOptions, setShipmentOptions] = useState<ShipmentOption[]>([])
  // 常用品名 / 等级，录明细时当候选
  const [dict, setDict] = useState<DictAll>({ species: [], grade: [] })
  const [shipmentId, setShipmentId] = useState(0)

  const [detail, setDetail] = useState<InboundDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')

  // 导出
  const [exporting, setExporting] = useState(false)
  const [exportHint, setExportHint] = useState('')

  // 删除
  const [deleteTarget, setDeleteTarget] = useState<{
    id: number
    order_no: string
  } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [actionError, setActionError] = useState('')

  const [form, setForm] = useState({
    supplier: '',
    orderDate: todayISO(),
    // remark 保留在表单里但不再显示：编辑老单据时不能把小票上的备注抹掉
    remark: '',
    warehouse: '',
    operator: '',
    blNo: '',
    vehicleNo: '',
    contractNo: '',
  })
  const [rows, setRows] = useState<FormRow[]>(() => padRows([]))
  // 表格左侧勾选的行（批量删除用）
  const [pickedRows, setPickedRows] = useState<number[]>([])
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [rowErrors, setRowErrors] = useState<Record<number, string[]>>({})
  const [hasValidated, setHasValidated] = useState(false)
  /** 手机端哪些明细行点了「更多」（展开柜号/品牌/数量/金额这些次要字段） */
  const [expandedRows, setExpandedRows] = useState<number[]>([])

  const toggleRowExpanded = (key: number) =>
    setExpandedRows((prev) =>
      prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key],
    )

  // 「该规格已有库存」提醒（只提示，不影响保存）
  const [stockLookup, setStockLookup] = useState<
    Record<string, { cubic: number; bundles: number }>
  >({})
  const lookedUpSpecies = useRef<Set<string>>(new Set())

  // 详情弹层的关闭入口统一走这里，Esc / 点遮罩 / 关闭按钮行为一致
  const closeDetail = useCallback(() => {
    setDetail(null)
    setDetailError('')
    setDetailLoading(false)
  }, [])

  // Esc 关闭最上面那层弹层（删除确认优先于详情）
  useEscapeKey(Boolean(deleteTarget) && !deleting, () => setDeleteTarget(null))
  useEscapeKey(
    !deleteTarget && Boolean(detail || detailLoading || detailError),
    closeDetail,
  )

  const loadList = useCallback(
    async (nextFilters: InboundListFilters, nextOffset: number) => {
      setListLoading(true)
      setListError('')
      try {
        const result = await fetchInboundList({
          ...nextFilters,
          limit: PAGE_SIZE,
          offset: nextOffset,
        })
        setList(result.rows)
        setTotal(result.total)
      } catch (err) {
        setListError(err instanceof Error ? err.message : '加载失败')
      } finally {
        setListLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    void loadList(filters, offset)
  }, [loadList, filters, offset, reloadToken])

  // 打开表单时拉一次合同列表，供「合同号」下拉选择
  useEffect(() => {
    if (mode !== 'create') return
    let cancelled = false
    void Promise.all([fetchContractOptions(), fetchShipmentOptions(), fetchDict()])
      .then(([contracts, boxes, dictData]) => {
        if (cancelled) return
        setContractOptions(contracts)
        setShipmentOptions(boxes)
        setDict(dictData)
      })
      .catch(() => {
        // 拉不到就退化成手填，不打扰用户
      })
    return () => {
      cancelled = true
    }
  }, [mode, editing])

  /**
   * 从 `/inbound/edit/:id` 直接进来：挂载时把那张单拉出来填进表单。
   * （列表/详情里的「编辑」按钮现在都是跳到这个地址，入口只有一个。）
   */
  useEffect(() => {
    if (defaultMode !== 'edit') return
    const id = Number(editIdParam)
    if (!Number.isInteger(id) || id <= 0) return
    void openEdit({ id })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultMode, editIdParam])

  /**
   * 提单号只手输，但失焦时解析一次：填的号如果已经是系统里的某张提单，
   * 就把 shipmentId 挂上——用于「同提单包号查重」和「条码号按这票顺序编号」。
   * 匹配规则跟后端一致：去空格 + 不区分大小写。
   */
  const matchShipmentId = (blNo: string) => {
    const key = blNo.trim().toLowerCase()
    if (!key) return 0
    const hit = shipmentOptions.find((item) => item.bl_no.trim().toLowerCase() === key)
    return hit ? hit.id : 0
  }

  /**
   * 提单号失焦时问一下后端：这个号下面还有没有活着的入库单？
   * 有就地提示「已经有入库单 RK…（已入 X 方）」+「去编辑那张单」，
   * 免得同一票货不知不觉录成两张。
   *
   * - 300ms 防抖：连着改几次号只查最后一次
   * - 竞态保护：只认最后一次请求的响应（`blCheckSeq`），慢响应回来不会覆盖新结果
   * - 编辑时排除自己（`exclude_id`）
   */
  const blCheckTimer = useRef<number | null>(null)
  const blCheckSeq = useRef(0)
  const [blHint, setBlHint] = useState<{ id: number; order_no: string; cubic: number } | null>(null)

  const checkBlNo = async (value: string, excludeId?: number) => {
    const key = value.trim()
    const seq = (blCheckSeq.current += 1)
    if (!key) {
      setBlHint(null)
      return
    }
    try {
      const res = await fetchInboundByBlNo({ blNo: key, excludeId })
      if (seq !== blCheckSeq.current) return
      setBlHint(res.order ?? null)
    } catch {
      // 查不动就不打扰用户（保存时后端还会再拦一次）
      if (seq === blCheckSeq.current) setBlHint(null)
    }
  }

  /** 防抖 300ms 再查 */
  const scheduleBlCheck = (value: string, excludeId?: number) => {
    if (blCheckTimer.current) window.clearTimeout(blCheckTimer.current)
    blCheckTimer.current = window.setTimeout(() => void checkBlNo(value, excludeId), 300)
  }

  /* ---------- 关联采购合同：弹一个大页面按合同明细挑 ---------- */

  const loadPicker = useCallback(async (keyword: string, nextOffset: number) => {
    setPickerLoading(true)
    setPickerError('')
    try {
      const page = await fetchContractPicker({
        keyword: keyword.trim() || undefined,
        limit: PICKER_PAGE_SIZE,
        offset: nextOffset,
      })
      setPickerRows(page.rows)
      setPickerTotal(page.total)
    } catch (err) {
      setPickerError(err instanceof Error ? err.message : '加载合同失败')
    } finally {
      setPickerLoading(false)
    }
  }, [])

  const openContractPicker = () => {
    setPickerKeyword('')
    setPickerOffset(0)
    setPickerPick(null)
    setPickerOpen(true)
    void loadPicker('', 0)
  }

  const confirmPick = () => {
    if (!pickerPick) {
      setPickerError('请先勾选一个采购合同')
      return
    }
    setPickedContract(pickerPick)
    setMethod('contract')
    setPickerOpen(false)
  }

  /** 「下一步」：按选好的方式进入录入表单 */
  const startCreate = () => {
    if (method === 'contract' && !pickedContract) {
      setFormError('')
      setPickerError('请先选择采购合同')
      openContractPicker()
      return
    }
    setEditing(null)
    setShipmentId(0)
    setRows(padRows([]))
    setPickedRows([])
    setRowErrors({})
    setFormError('')
    setForm({
      // 挂了合同就把供应商（往来单位）一起带出来，省得再打一遍
      supplier: method === 'contract' ? pickedContract?.partner ?? '' : '',
      orderDate: todayISO(),
      remark: '',
      warehouse: '',
      operator: '',
      blNo: '',
      vehicleNo: '',
      contractNo: method === 'contract' ? pickedContract?.contract_no ?? '' : '',
    })
    setMode('create')
  }

  /** 列表里点合同号 → 直接打开那份 PDF */
  const handleOpenContract = async (contractId: number, contractNo: string) => {
    setActionError('')
    try {
      await openContractFile(contractId)
    } catch (err) {
      setActionError(
        err instanceof Error
          ? `打开合同 ${contractNo} 失败：${err.message}`
          : `打开合同 ${contractNo} 失败`,
      )
    }
  }

  // 首次点保存后转为实时校验：改一个字段就刷新标红结果
  useEffect(() => {
    if (!hasValidated) return
    setRowErrors(validateRows(rows))
  }, [rows, hasValidated])

  const computedRows = useMemo(
    () =>
      rows.map((row) => {
        const cubic = previewCubic(row)
        return {
          ...row,
          specKey: specKeyOf(row),
          cubic,
          amount: previewAmount(cubic, row.unitPrice),
        }
      }),
    [rows],
  )

  // 规格填全后按品名拉一次库存，判断这个规格是不是已经有库存
  useEffect(() => {
    const pendingSpecies = new Set<string>()
    for (const row of computedRows) {
      if (row.specKey && !lookedUpSpecies.current.has(row.species.trim())) {
        pendingSpecies.add(row.species.trim())
      }
    }
    if (pendingSpecies.size === 0) return

    let cancelled = false
    for (const species of pendingSpecies) {
      lookedUpSpecies.current.add(species)
      void fetchStockList(species)
        .then((rows) => {
          if (cancelled) return
          setStockLookup((prev) => {
            const next = { ...prev }
            for (const item of rows) {
              next[
                [
                  item.species,
                  item.grade ?? '',
                  item.thickness,
                  item.width,
                  item.length,
                ].join('|')
              ] = { cubic: item.total_cubic, bundles: item.total_bundles }
            }
            return next
          })
        })
        .catch(() => {
          lookedUpSpecies.current.delete(species)
        })
    }

    return () => {
      cancelled = true
    }
  }, [computedRows])

  const totals = useMemo(
    () =>
      computedRows.reduce(
        (acc, row) => ({
          cubic: roundTo(acc.cubic + row.cubic, 4),
          amount: roundTo(acc.amount + row.amount, 2),
          // 片数按「每片数 × 件数」累计，就是这批货一共多少片
          pieces: acc.pieces + toNumber(row.pieces) * toNumber(row.bundles),
          bundles: acc.bundles + toNumber(row.bundles),
        }),
        { cubic: 0, amount: 0, pieces: 0, bundles: 0 },
      ),
    [computedRows],
  )

  /**
   * 合计行末尾这几格，顺序和表头最后 7 列一一对应：
   * 片数 / 件数 / 数量(m³) / 单位 / 单价 / 金额 / 条码号。
   * 「合计」那个标签跨多少列，按总列数减去这里的格数倒推。
   */
  const totalTailCells = [
    { key: 'pieces', className: 'num', value: totals.pieces || '' },
    { key: 'bundles', className: 'num', value: totals.bundles || '' },
    { key: 'cubic', className: 'num', value: formatCubic(totals.cubic) },
    { key: 'unit', className: undefined, value: 'm³' },
    { key: 'price', className: undefined, value: '' },
    { key: 'amount', className: 'num', value: formatAmount(totals.amount) },
    { key: 'barcode', className: undefined, value: '' },
  ]

  /**
   * 看不到金额时，「金额」那一列整列不存在，合计行末尾也要少一格。
   * 「单价」列保留（还是个要填的输入框），所以那一格空占位留着。
   * 总列数同理减 1 —— 合计行的 colspan 是从它倒推的，不能写死。
   */
  const tailCells = money
    ? totalTailCells
    : totalTailCells.filter((cell) => cell.key !== 'amount')
  const sheetColCount = SHEET_COL_COUNT - (money ? 0 : 1)

  // 当前选中的提单（条码号按这票提单的顺序排）
  const activeShipment = useMemo(
    () => shipmentOptions.find((item) => item.id === shipmentId) ?? null,
    [shipmentOptions, shipmentId],
  )

  /**
   * 这次保存会生成几个条码号。
   * 手填了包号的行：同一个包号算一包（多个规格并进同一张码）；
   * 没填包号的行：按件数（=包数）算。
   */
  const barcodePlan = useMemo(() => {
    if (!activeShipment) return null

    const labels = new Set<string>()
    let count = 0
    for (const row of computedRows) {
      if (isRowEmpty(row)) continue
      // 「同包再加一行」不新开包，所以不占条码号

      const label = row.baleLabel.trim()
      if (label) {
        for (const one of parseBaleLabels(label)) {
          if (labels.has(one)) continue
          labels.add(one)
          count += 1
        }
        continue
      }
      count += Math.max(0, Math.round(toNumber(row.bundles)))
    }

    if (count <= 0) return null
    const from = activeShipment.next_seq
    const to = from + count - 1
    const prefix = activeShipment.bl_no
    return {
      count,
      text:
        from === to
          ? `${prefix}-${padBaleSeq(from)}`
          : `${prefix}-${padBaleSeq(from)} ~ ${prefix}-${padBaleSeq(to)}`,
    }
  }, [computedRows, activeShipment])

  /** 柜数：明细里填了几个不同的柜号，系统自己数 */
  const boxCount = useMemo(() => {
    const boxes = new Set<string>()
    for (const row of computedRows) {
      if (isRowEmpty(row)) continue
      const box = row.boxNo.trim()
      if (box) boxes.add(box)
    }
    return boxes.size
  }, [computedRows])

  /** 填了内容的行数：只剩 1 行时不让删，否则整张单会变空 */
  const filledRowCount = useMemo(
    () => computedRows.filter((row) => !isRowEmpty(row)).length,
    [computedRows],
  )

  /**
   * 勾选的行里有多少行是「有内容」的。
   * 如果勾选把有内容的行全占了，批量删除后这张单就一行明细都不剩 ——
   * 按「至少要保留一行明细」处理：按钮置灰，和改包/出库的删最后一行规则一致。
   */
  const pickedFilledCount = useMemo(
    () =>
      computedRows.filter((row) => !isRowEmpty(row) && pickedRows.includes(row.key))
        .length,
    [computedRows, pickedRows],
  )
  const deleteWouldEmptySheet =
    pickedFilledCount > 0 && pickedFilledCount >= filledRowCount

  /**
   * 包号失焦就查一次重：范围是「这张提单内」（散货新单没有单据号，无可查）。
   * 命中就当场标红，不用等到保存。
   */
  const checkRowBaleNo = async (key: number) => {
    const row = rows.find((item) => item.key === key)
    const label = row?.baleLabel.trim() ?? ''

    try {
      const result = await checkBaleNo({
        bale_no: label,
        shipment_id: shipmentId,
        inbound_order_id: editing?.id,
      })
      if (!result.exists) return
      setRowErrors((prev) => ({
        ...prev,
        [key]: [
          ...(prev[key] ?? []).filter((item) => !item.includes('已存在')),
          `包号 ${label} 在这张提单里已存在，请换一个包号${
            result.barcode ? `（已用在 ${result.barcode}）` : ''
          }`,
        ],
      }))
      setHasValidated(true)
    } catch {
      // 查重失败不打扰用户，保存时后端还会再拦一次
    }
  }

  const updateRow = (
    key: number,
    field: keyof Omit<FormRow, 'key'>,
    value: string,
  ) => {
    setRows((prev) => {
      const next = prev.map((row) => {
        if (row.key !== key) return row
        const patched = { ...row, [field]: value }
        // 第一次往里填东西时，片数 / 件数给个 1 的默认值，省得每行都手打
        if (field !== 'pieces' && field !== 'bundles') {
          if (!patched.pieces.trim()) patched.pieces = '1'
          if (!patched.bundles.trim()) patched.bundles = '1'
        }
        return patched
      })
      // 末尾永远留一行空的，接着往下填就行
      const last = next[next.length - 1]
      if (last && last.key === key && !isRowEmpty(last)) next.push(createRow())
      return next
    })
    // 改动后旧提示就过期了，清掉；行内标红由实时校验刷新
    if (formError) setFormError('')
  }

  const addRow = () => {
    setRows((prev) => [...prev, createRow()])
    if (formError) setFormError('')
  }

  /** 在指定行下面插一行空行（行内「+ 加行」按钮） */
  const insertRowAfter = (key: number) => {
    setRows((prev) => {
      const index = prev.findIndex((row) => row.key === key)
      if (index < 0) return [...prev, createRow()]
      const next = [...prev]
      next.splice(index + 1, 0, createRow())
      return next
    })
    if (formError) setFormError('')
  }

  /**
   * 复制本行：字段照抄、**包号清空**（一个包号只能对应一包货，复制过来必然撞号），
   * 新行插在这一行的下面（点第 N 行 → 新行落在第 N+1 行）。
   */
  const copyRow = (key: number) => {
    setRows((prev) => {
      const index = prev.findIndex((row) => row.key === key)
      if (index < 0) return prev
      const row = prev[index]
      const next = [...prev]
      next.splice(index + 1, 0, {
        ...createRow(),
        boxNo: row.boxNo,
        brand: row.brand,
        species: row.species,
        grade: row.grade,
        thickness: row.thickness,
        width: row.width,
        length: row.length,
        pieces: row.pieces,
        bundles: row.bundles,
        unitPrice: row.unitPrice,
      })
      return next
    })
    if (formError) setFormError('')
  }

  const removeRow = (key: number) => {
    setRows((prev) => {
      const target = prev.find((row) => row.key === key)
      // 只剩这一行有内容时不删：删完整张单就空了（按钮那边会置灰并给出提示）
      const filled = prev.filter((row) => !isRowEmpty(row)).length
      if (target && !isRowEmpty(target) && filled <= 1) return prev
      return padRows(prev.filter((row) => row.key !== key))
    })
    setPickedRows((prev) => prev.filter((item) => item !== key))
    if (formError) setFormError('')
  }

  /** 删掉勾选的行 */
  const removePickedRows = () => {
    if (pickedRows.length === 0) return
    // 删完一行明细都不剩：不删、不动（按钮那边也会置灰并给出提示）
    if (deleteWouldEmptySheet) return
    setRows((prev) => padRows(prev.filter((row) => !pickedRows.includes(row.key))))
    setPickedRows([])
    if (formError) setFormError('')
  }

  const handleSearch = () => {
    setNotice('')
    setOffset(0)
    setFilters({
      order_no: input.order_no.trim(),
      supplier: input.supplier.trim(),
      warehouse: input.warehouse.trim(),
      operator: input.operator.trim(),
      date_from: input.date_from,
      date_to: input.date_to,
    })
  }

  const handleResetFilters = () => {
    setInput(emptyInput)
    setOffset(0)
    setFilters(emptyFilters)
  }

  const handleExport = async () => {
    if (list.length === 0) {
      setExportHint('当前没有可导出的数据')
      return
    }
    setExporting(true)
    try {
      await downloadFile(
        inboundExportUrl({
          supplier: filters.supplier,
          date_from: filters.date_from,
          date_to: filters.date_to,
        }),
        '入库明细.xlsx',
      )
    } catch (err) {
      setExportHint(err instanceof Error ? err.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  const openCreate = () => {
    setNotice('')
    setFormError('')
    setEditing(null)
    setLegacyNoBl(false)
    setRowErrors({})
    setHasValidated(false)
    // 先走「请选择入库方式」，和千木云一致
    setMethod('direct')
    setPickedContract(null)
    setMode('method')
  }

  // 修改：拉出原单明细填进同一套表单，保存时走 PUT，单号保持不变
  const openEdit = async (item: { id: number; order_no?: string }) => {
    setNotice('')
    setFormError('')
    setActionError('')
    try {
      const data = await fetchInboundDetail(item.id)
      setForm({
        supplier: data.supplier ?? '',
        orderDate: data.order_date ?? todayISO(),
        remark: data.remark ?? '',
        warehouse: data.warehouse ?? '',
        operator: data.operator ?? '',
        blNo: data.bl_no ?? '',
        contractNo: data.contract_no ?? '',
        vehicleNo: data.vehicle_no ?? '',
      })
      setRows(
        padRows(
          data.items.map((line) => ({
          key: (rowSeq += 1),
          // 包号从这张单的包里读回来（编辑会同步重建码单）
          baleLabel: line.bale_no
            ? line.bale_no
            : (line.bale_labels ?? []).join('、'),
          boxNo: line.box_no ?? '',
          brand: line.brand ?? '',
          species: line.species ?? '',
          grade: line.grade ?? '',
          thickness: String(line.thickness ?? ''),
          width: String(line.width ?? ''),
          length: String(line.length ?? ''),
          pieces: String(line.pieces ?? 1),
          bundles: String(line.bundles ?? 1),
          unitPrice:
            line.unit_price === null || line.unit_price === undefined
              ? ''
              : String(line.unit_price),
          })),
        ),
      )
      setPickedRows([])
      setRowErrors({})
      setHasValidated(false)
      // 单号以拉回来的详情为准（从 /inbound/edit/:id 进来时只有 id）
      setEditing({ id: item.id, order_no: data.order_no ?? item.order_no ?? '' })
      // 原单本来就没提单号 → 这张是老单据，允许留空保存
      setLegacyNoBl(!String(data.bl_no ?? '').trim())
      setMode('create')
      closeDetail()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '打开编辑失败')
    }
  }

  const openDetail = async (id: number) => {
    setDetailLoading(true)
    setDetailError('')
    setDetail(null)
    try {
      setDetail(await fetchInboundDetail(id))
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setDetailLoading(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return

    setDeleting(true)
    setActionError('')
    try {
      await deleteInbound(deleteTarget.id)
      setDeleteTarget(null)
      setDetail(null)
      setNotice(`已把入库单 ${deleteTarget.order_no} 移入回收站`)
      setReloadToken((n) => n + 1)
    } catch (err) {
      // 后端返回的原因（比如删了会超卖）原样展示
      setDeleteTarget(null)
      setActionError(err instanceof Error ? err.message : '移入回收站失败')
    } finally {
      setDeleting(false)
    }
  }

  /**
   * 保存入库单。
   * `force = true` 表示用户已经确认过「这个提单号已经有活单，仍要新建」，
   * 重发时带上 `force:true` 让后端跳过那条校验（其余校验照旧）。
   */
  /**
   * 把用户带到出问题的地方：滚过去 + 聚焦。
   * 手机上一条明细就占大半屏，光在顶部弹一句"有 N 行有误"根本找不到。
   */
  const scrollToField = (field: string) => {
    window.setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>(`input[data-field="${field}"]`)
      if (!input) return
      input.focus({ preventScroll: true })
      input.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 60)
  }

  /**
   * 点「常用规格」：填到**第一行还没填完的空行**；
   * 没有空行就在最后加一行。只填规格，不碰包号（包号一包一个，得手写）。
   */
  const fillSpec = (spec: RecentSpec) => {
    tapFeedback()
    const empty = rows.find((row) => !row.species.trim() && !row.thickness.trim())
    const target = empty ?? rows[rows.length - 1]
    if (!target) return
    if (!empty) insertRowAfter(target.key)
    setRows((prev) =>
      prev.map((row) =>
        row.key === target.key
          ? {
              ...row,
              species: spec.species,
              grade: spec.grade,
              thickness: spec.thickness,
              width: spec.width,
              length: spec.length,
            }
          : row,
      ),
    )
  }

  const handleSave = async (force = false, continueAfter = false) => {
    const supplier = form.supplier.trim()

    setHasValidated(true)
    const errors = validateRows(rows)
    setRowErrors(errors)
    setFormError('')

    if (!supplier) {
      setFormError('供应商不能为空')
      scrollToField('supplier')
      return
    }
    if (!form.warehouse.trim()) {
      setFormError('仓库不能为空')
      scrollToField('warehouse')
      return
    }
    // 提单号必填；老单据（入库那会儿还没这条规则）允许继续空着保存
    if (!form.blNo.trim() && !legacyNoBl) {
      setFormError('提单号必填，一票货一个号')
      scrollToField('blNo')
      return
    }

    const filledRows = computedRows.filter((row) => !isRowEmpty(row))
    if (filledRows.length === 0) {
      setFormError('至少需要一行明细')
      return
    }

    const errorRows = Object.keys(errors).length
    if (errorRows > 0) {
      setFormError(`明细有 ${errorRows} 行填写有误，请按红色提示修正后再保存`)
      // 手机上滚一下很关键：录了十几行以后，光说"有误"等于让人自己一行行找
      const firstKey = Object.keys(errors)[0]
      window.setTimeout(() => {
        const tr = document.querySelector<HTMLElement>(`tr[data-row-key="${firstKey}"]`)
        if (!tr) return
        tr.querySelector<HTMLInputElement>('input.sheet-input')?.focus({ preventScroll: true })
        tr.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }, 60)
      return
    }

    const items: InboundItemPayload[] = filledRows.map((row) => ({
      brand: row.brand.trim(),
      species: row.species.trim(),
      grade: row.grade.trim(),
      thickness: toNumber(row.thickness),
      width: toNumber(row.width),
      /**
       * 长度 / 片数原样把**字符串**发上去：
       * 混装包写的是「1800/2100/2400」「17/30/247」，先 toNumber 会变成 NaN → 0，
       * 服务端就拆不出这几段了。普通行发字符串它也认（内部 toMeters / Number）。
       */
      length: row.length.trim(),
      pieces: row.pieces.trim(),
      bundles: toNumber(row.bundles),
      unit_price: toNumber(row.unitPrice),
      // 包号：填了范围就按范围生成码单，留空让后端自动编号
      bale_labels: parseBaleLabels(row.baleLabel),
      box_no: row.boxNo.trim(),
    }))

    setSaving(true)
    setFormError('')
    try {
      const payload = {
        supplier,
        order_date: form.orderDate,
        remark: form.remark.trim(),
        warehouse: form.warehouse.trim(),
        operator: form.operator.trim(),
        bl_no: form.blNo.trim(),
        vehicle_no: form.vehicleNo.trim(),
        contract_no: form.contractNo.trim(),
        shipment_id: shipmentId || undefined,
        items,
        // 用户已经确认过「仍要新建」→ 让后端跳过"这个提单号已有活单"那条校验
        ...(force ? { force: true } : {}),
      }
      const result = editing
        ? await updateInbound(editing.id, payload)
        : await createInbound(payload)
      // 记住这次用到的规格，下次录单在明细上方点一下就填好
      setRecentSpecs(rememberSpecs(items))
      if (continueAfter) {
        /**
         * 「保存并继续」：存完**留在表单**接着录下一张 ——
         * 表头（供应商 / 日期 / 仓库 / 提单号 / 合同）保留，明细和备注清空。
         * 提单号保留是有意的：同一票分批到货时直接往上加，
         * 号重复了失焦提示会告诉他"这号已经有单"，可以一键去那张单追加。
         */
        setRows(padRows([]))
        setPickedRows([])
        setExpandedRows([])
        setRowErrors({})
        setForm((prev) => ({ ...prev, remark: '' }))
        lookedUpSpecies.current.clear()
        setStockLookup({})
        setNotice(`已保存入库单 ${result.order_no}，可以接着录下一张`)
        window.setTimeout(() => window.scrollTo({ top: 0, behavior: 'smooth' }), 60)
        return
      }
      // 回到列表：清空筛选后重新加载，保证新单一定可见
      setMode('list')
      setEditing(null)
      setLegacyNoBl(false)
      setForm({
        supplier: '',
        orderDate: todayISO(),
        remark: '',
        warehouse: '',
        operator: '',
        blNo: '',
        vehicleNo: '',
        contractNo: '',
      })
      setRows(padRows([]))
      setPickedRows([])
      // 入库后库存变了，清掉「已有库存」提醒缓存
      lookedUpSpecies.current.clear()
      setStockLookup({})
      // 清掉筛选并回到第一页，保证刚保存的单一定看得见
      setInput(emptyInput)
      setFilters(emptyFilters)
      setOffset(0)
      setReloadToken((n) => n + 1)
      setNotice(
        editing
          ? `已保存入库单 ${result.order_no} 的修改`
          : `已保存入库单 ${result.order_no}`,
      )
    } catch (err) {
      /**
       * 这个提单号已经有一张活单（后端 409 + BL_HAS_ORDER）：
       * 弹三按钮让用户选「去编辑那张单 / 仍要新建 / 取消」，
       * 而不是当成一句普通报错吞掉。
       */
      if (isBlHasOrderError(err)) {
        setBlConflict({ message: err.message, order: err.payload?.order ?? null })
        return
      }
      setFormError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section>
      <PageHead
        title="采购入库"
        subtitle={
          mode === 'method'
            ? '先选入库方式：整票到货就挂采购合同，零散到货直接入库'
            : mode === 'create'
              ? '包号照货上写的填，条码号由系统生成（就是之后要打印贴包上的那张码）'
              : '按供应商、日期、仓库查询已录入的入库单，可查看明细、编辑或删除；点「新增采购」开始录新单'
        }
        extra={
          mode === 'list' ? (
            <>
              <button className="btn" onClick={handleExport} disabled={exporting}>
                {exporting ? '导出中…' : '导出 Excel'}
              </button>
              {canWrite && (
                <button className="btn btn-primary" onClick={openCreate}>
                  新增采购
                </button>
              )}
            </>
          ) : null
        }
      />

      <ToastHost
        items={[
          exportHint
            ? {
                id: 'inbound-export-hint',
                kind: 'info' as const,
                message: exportHint,
                onClose: () => setExportHint(''),
              }
            : null,
          notice
            ? {
                id: 'inbound-notice',
                kind: 'success' as const,
                message: notice,
                onClose: () => setNotice(''),
              }
            : null,
          actionError
            ? {
                id: 'inbound-action-error',
                kind: 'error' as const,
                message: actionError,
                onClose: () => setActionError(''),
              }
            : null,
          listError
            ? {
                id: 'inbound-list-error',
                kind: 'error' as const,
                message: listError,
                onClose: () => setListError(''),
              }
            : null,
          formError
            ? {
                id: 'inbound-form-error',
                kind: 'error' as const,
                message: formError,
                onClose: () => setFormError(''),
              }
            : null,
          detailError
            ? {
                id: 'inbound-detail-error',
                kind: 'error' as const,
                message: detailError,
                onClose: () => setDetailError(''),
              }
            : null,
        ]}
      />

      {mode === 'method' ? (
        <div className="card">
          <h2 className="section-title">请选择入库方式</h2>
          <div className="method-options">
            <label className={method === 'direct' ? 'method-option is-active' : 'method-option'}>
              <input
                type="radio"
                name="inbound-method"
                checked={method === 'direct'}
                onChange={() => setMethod('direct')}
              />
              <span className="method-body">
                <strong>直接入库</strong>
                <em>零散到货、还没归档的货，直接录进来</em>
              </span>
            </label>

            <label className={method === 'contract' ? 'method-option is-active' : 'method-option'}>
              <input
                type="radio"
                name="inbound-method"
                checked={method === 'contract'}
                onChange={() => {
                  setMethod('contract')
                  if (!pickedContract) openContractPicker()
                }}
              />
              <span className="method-body">
                <strong>关联采购合同</strong>
                <em>整票到货挂到采购合同上，方便对账和查这单入了多少</em>
              </span>
              {method === 'contract' && (
                pickedContract ? (
                  <span className="method-picked">
                    <b>{pickedContract.contract_no}</b>
                    <i>
                      {[pickedContract.title, pickedContract.partner]
                        .filter(Boolean)
                        .join(' · ')}
                    </i>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={(event) => {
                      event.preventDefault()
                      openContractPicker()
                    }}
                  >
                    选择合同
                  </button>
                )
              )}
            </label>
          </div>

          <div className="method-foot">
            {method === 'contract' && pickedContract && (
              <button type="button" className="btn btn-sm btn-quiet" onClick={openContractPicker}>
                重新选择合同
              </button>
            )}
            <button className="btn btn-primary" onClick={startCreate}>
              下一步
            </button>
          </div>
        </div>
      ) : mode === 'list' ? (
        <>
          <PullIndicator distance={pullDistance} busy={pullBusy} />
          <div className="toolbar toolbar-sticky">
            <input
              className="input toolbar-search"
              placeholder="单号关键字"
              value={input.order_no}
              onChange={(event) =>
                setInput((prev) => ({ ...prev, order_no: event.target.value }))
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleSearch()
              }}
            />
            {/* 手机端：搜索一行 + 「筛选」按钮，其余条件收进底部 sheet */}
            <button
              type="button"
              className="btn filter-toggle"
              onClick={() => setFilterOpen((open) => !open)}
            >
              筛选
              {activeFilterCount > 0 ? ` · ${activeFilterCount}` : ''}
            </button>
            <div className={filterOpen ? 'filter-sheet is-open' : 'filter-sheet'}>
              <div className="filter-sheet-head">
                <span>筛选</span>
                <button
                  type="button"
                  className="btn btn-sm btn-quiet"
                  onClick={() => setFilterOpen(false)}
                >
                  关闭
                </button>
              </div>
            <input
              className="input"
              placeholder="供应商关键字"
              value={input.supplier}
              onChange={(event) =>
                setInput((prev) => ({ ...prev, supplier: event.target.value }))
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleSearch()
              }}
            />
            <input
              className="input"
              placeholder="仓库关键字"
              value={input.warehouse}
              onChange={(event) =>
                setInput((prev) => ({ ...prev, warehouse: event.target.value }))
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleSearch()
              }}
            />
            <input
              className="input"
              placeholder="操作员"
              value={input.operator}
              onChange={(event) =>
                setInput((prev) => ({ ...prev, operator: event.target.value }))
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleSearch()
              }}
            />
            <input
              className="input"
              type="date"
              value={input.date_from}
              onChange={(event) =>
                setInput((prev) => ({ ...prev, date_from: event.target.value }))
              }
            />
            <span className="muted">至</span>
            <input
              className="input"
              type="date"
              value={input.date_to}
              onChange={(event) =>
                setInput((prev) => ({ ...prev, date_to: event.target.value }))
              }
            />
              <div className="filter-sheet-actions">
                <button className="btn" onClick={handleResetFilters}>
                  重置
                </button>
                <button className="btn btn-primary" onClick={() => { handleSearch(); setFilterOpen(false) }}>
                  查询
                </button>
              </div>
            </div>
            {filterOpen && (
              <div className="filter-sheet-mask" onClick={() => setFilterOpen(false)} />
            )}
            <span className="spacer" />
          </div>

          <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>单号</th>
                <th>供应商</th>
                <th>日期</th>
                <th>仓库</th>
                <th>合同号 / 提单号</th>
                <th className="num">总立方</th>
                {money && <th className="num">总金额</th>}
                <th className="num">明细数</th>
                <th className="num">码单</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((order) => (
                <tr
                  key={order.id}
                  className={swipedId === order.id ? 'is-swiped' : undefined}
                  /* 手机端左滑露出快捷操作；桌面端不触发（没有 touch 事件） */
                  onTouchStart={(event) => {
                    swipeStartX.current = event.touches[0]?.clientX ?? 0
                  }}
                  onTouchMove={(event) => {
                    const dx = (event.touches[0]?.clientX ?? 0) - swipeStartX.current
                    if (dx < -34) setSwipedId(order.id)
                    else if (dx > 34) setSwipedId(null)
                  }}
                  onClickCapture={(event) => {
                    // 已经滑开时，点卡片本身先收起来（别顺手点了按钮）
                    if (swipedId === order.id) {
                      event.preventDefault()
                      event.stopPropagation()
                      setSwipedId(null)
                    }
                  }}
                >
                  <td className="col-wide">{order.order_no}</td>
                  <td className="col-third">{order.supplier}</td>
                  <td className="col-third">{order.order_date}</td>
                  <td className="col-third">{order.warehouse || '—'}</td>
                  <td className="col-wide">
                    {order.contract_no ? (
                      order.contract_id ? (
                        <button
                          type="button"
                          className="link-btn"
                          onClick={() => void handleOpenContract(order.contract_id!, order.contract_no!)}
                        >
                          {order.contract_no}
                        </button>
                      ) : (
                        order.contract_no
                      )
                    ) : (
                      '—'
                    )}
                    {order.bl_no ? (
                      <span className="cell-sub">提单 {order.bl_no}</span>
                    ) : null}
                  </td>
                  <td className="num col-third">{formatCubic(order.total_cubic)}</td>
                  {money && (
                    <td className="num amount col-third">
                      {formatAmount(order.total_amount)}
                    </td>
                  )}
                  <td className="num col-third">{order.item_count}</td>
                  <td className="num col-wide">
                    {order.bale_total > 0 ? (
                      <>
                        {order.bale_total} 包
                        <span className="cell-sub">
                          在库 {order.bale_in_stock} / 已出{' '}
                          {order.bale_total - order.bale_in_stock}
                        </span>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="cell-actions">
                    {/* 左滑露出来的两个快捷按钮（桌面端隐藏：桌面有整排按钮） */}
                    <div className="swipe-actions">
                      <button
                        type="button"
                        className="swipe-btn"
                        onClick={() => navigate(`/inbound/edit/${order.id}`)}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="swipe-btn is-danger"
                        onClick={() => {
                          setSwipedId(null)
                          setDeleteTarget({ id: order.id, order_no: order.order_no })
                        }}
                      >
                        移入回收站
                      </button>
                    </div>
                    <div className="row-actions">
                      <button
                        className="btn btn-sm"
                        onClick={() => void openDetail(order.id)}
                      >
                        查看
                      </button>
                      {canWrite && (
                        <>
                          <button
                            className="btn btn-sm"
                            onClick={() => navigate(`/inbound/edit/${order.id}`)}
                          >
                            编辑
                          </button>
                          <button
                            className="btn btn-sm btn-danger"
                            title="移入回收站，可在回收站恢复"
                            onClick={() =>
                              setDeleteTarget({
                                id: order.id,
                                order_no: order.order_no,
                              })
                            }
                          >
                            移入回收站
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!listLoading && list.length === 0 && (
            <EmptyState
              text="暂无入库单"
              hint="按提单一包包进货；同一张单里品名/规格/片数一样的两行会自动合并"
              action={{ label: '新增入库', to: '/inbound/new' }}
            />
          )}
        {listLoading && <TableSkeleton rows={6} cols={5} />}
          <Pager
            total={total}
            limit={PAGE_SIZE}
            offset={offset}
            onChange={setOffset}
            unit="张入库单"
          />
        </div>
        </>
      ) : (
        <div className="card sheet">
          <datalist id="contract-options">
            {contractOptions.map((option) => (
              <option key={option.id} value={option.contract_no}>
                {[option.title, option.partner].filter(Boolean).join(' · ')}
              </option>
            ))}
          </datalist>
          <datalist id="dict-species">
            {dict.species.map((item) => (
              <option key={item.id} value={item.name} />
            ))}
          </datalist>
          <datalist id="dict-grade">
            {dict.grade.map((item) => (
              <option key={item.id} value={item.name} />
            ))}
          </datalist>

          {/* 表头一行：供应商 / 入库日期 / 单号，右侧保存 */}
          <h2 className="form-section">基本信息</h2>
          <div className="sheet-top">
            <label className="sheet-field">
              <span>
                供应商<b className="req">*</b>
              </span>
              <input
                data-field="supplier"
                className="input"
                enterKeyHint="next"
                value={form.supplier}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, supplier: event.target.value }))
                }
              />
            </label>
            <label className="sheet-field">
              <span>入库日期</span>
              <input
                className="input"
                type="date"
                value={form.orderDate}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, orderDate: event.target.value }))
                }
              />
            </label>
            <label className="sheet-field">
              <span>单号</span>
              <input
                className="input input-readonly"
                readOnly
                value={editing ? editing.order_no : '默认系统生成'}
              />
            </label>
            <span className="spacer" />
            {/* 手机端这一组会固定到屏幕底部（Tab 栏上方），见 .sheet-actions */}
            <div className="sheet-actions">
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
              {/* 连着录好几张单时不用每次回列表：存完留在表单，表头保留、明细清空 */}
              <button
                className="btn btn-continue"
                onClick={() => {
                  tapFeedback()
                  void handleSave(false, true)
                }}
                disabled={saving}
              >
                保存并继续
              </button>
              <button
                className="btn"
                onClick={() => {
                  // 「取消」回到进来时的那个列表（/inbound/edit/:id 进来就是 /inbound）
                  setMode(defaultMode === 'edit' ? 'list' : defaultMode)
                  setEditing(null)
                  if (defaultMode === 'edit') navigate('/inbound')
                }}
              >
                取消
              </button>
            </div>
          </div>

          <h2 className="form-section">明细</h2>
          {/*
            常用规格：一点就把这一行的品名/等级/厚/宽/长填好。
            数据是本机记的（上一次保存时存的），不需要服务端配合。
          */}
          {recentSpecs.length > 0 && (
            <div className="spec-chips">
              <span className="spec-chips-label">常用规格</span>
              {recentSpecs.map((one) => (
                <button
                  key={`${one.species}-${one.grade}-${one.thickness}-${one.width}-${one.length}`}
                  type="button"
                  className="spec-chip"
                  title={`${one.species} ${one.grade || '（无等级）'} ${one.thickness}×${one.width}×${one.length}`}
                  onClick={() => fillSpec(one)}
                >
                  {one.thickness}×{one.width}×{one.length}
                  <em>{one.species}</em>
                </button>
              ))}
            </div>
          )}
          <div className="sheet-toolbar">
            {/* title 挂在 span 上：按钮 disabled 时原生 tooltip 不弹，外面的包裹层还能弹 */}
            <span
              title={
                deleteWouldEmptySheet
                  ? '至少要保留一行明细'
                  : pickedRows.length === 0
                    ? '先勾选要删除的明细行'
                    : '删除勾选的明细行'
              }
            >
              <button
                className="btn btn-sm btn-danger"
                onClick={removePickedRows}
                disabled={pickedRows.length === 0 || deleteWouldEmptySheet}
              >
                删除选中（{pickedRows.length}）
              </button>
            </span>
            <button className="btn btn-sm" onClick={addRow}>
              + 加一行
            </button>
            <span className="spacer" />
            <span className="muted">
              {activeShipment
                ? `条码号自动生成：这票提单已贴 ${activeShipment.bale_count} 张，下一个 ${activeShipment.bl_no}-${padBaleSeq(activeShipment.next_seq)}`
                : '条码号保存时按入库单号自动编'}
              {barcodePlan ? `　本次将生成 ${barcodePlan.count} 个：${barcodePlan.text}` : ''}
            </span>
          </div>

          <div className="sheet-scroll">
            {/* sheet-inbound：只在桌面端冻结「# + 操作」两列（横滑时钉在左边） */}
            <table className="sheet-table sheet-inbound">
              <thead>
                <tr>
                  <th className="col-no">#</th>
                  {/* 操作列放最左边（# 后面）：三张明细表位置一致，再也不用横滑去找 */}
                  <th className="col-op">操作</th>
                  <th className="col-check">
                    <input
                      type="checkbox"
                      checked={
                        computedRows.filter((row) => !isRowEmpty(row)).length > 0 &&
                        pickedRows.length ===
                          computedRows.filter((row) => !isRowEmpty(row)).length
                      }
                      onChange={(event) =>
                        setPickedRows(
                          event.target.checked
                            ? computedRows.filter((row) => !isRowEmpty(row)).map((row) => row.key)
                            : [],
                        )
                      }
                    />
                  </th>
                  {rowFields.map(({ field, label, hint }) => (
                    <th
                      key={field}
                      className={field === 'species' ? 'col-name' : undefined}
                      title={hint ? `${label}　${hint}` : undefined}
                    >
                      {label}
                    </th>
                  ))}
                  <th className="col-unit">数量 (m³)</th>
                  <th className="col-unit">单位</th>
                  <th>单价 (元) *</th>
                  {money && <th>金额 (元)</th>}
                  <th className="col-code">条码号</th>
                </tr>
              </thead>
              <tbody>
                {computedRows.map((row, index) => {
                  const reasons = rowErrors[row.key] ?? []
                  const hint = row.specKey ? stockLookup[row.specKey] : undefined
                  const filler = isRowEmpty(row)
                  return (
                    <Fragment key={row.key}>
                      <tr
                        data-row-key={row.key}
                        className={[
                          reasons.length > 0 ? 'is-error' : '',
                          expandedRows.includes(row.key) ? 'is-expanded' : '',
                        ]
                          .filter(Boolean)
                          .join(' ') || undefined}
                      >
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
                            title={
                              !filler && filledRowCount <= 1
                                ? '至少要保留一行'
                                : '删掉这一行'
                            }
                          >
                            <button
                              type="button"
                              className="sheet-act sheet-act-danger"
                              disabled={!filler && filledRowCount <= 1}
                              onClick={() => removeRow(row.key)}
                            >
                              ✕ 删行
                            </button>
                          </span>
                          {/* 手机端：展开/收起这一行的次要字段（桌面端这个按钮不显示，字段本来就都在） */}
                          <button
                            type="button"
                            className="sheet-act sheet-act-more"
                            onClick={() => toggleRowExpanded(row.key)}
                          >
                            {expandedRows.includes(row.key) ? '收起' : '更多'}
                          </button>
                        </td>
                        <td className="col-check">
                          <input
                            type="checkbox"
                            disabled={filler}
                            checked={pickedRows.includes(row.key)}
                            onChange={(event) =>
                              setPickedRows((prev) =>
                                event.target.checked
                                  ? [...prev, row.key]
                                  : prev.filter((item) => item !== row.key),
                              )
                            }
                          />
                        </td>
                        {rowFields.map(({ field }) => (
                          <td
                            key={field}
                            className={FIELD_COL_CLASS[field] ?? 'col-third'}
                            data-label={FIELD_SHORT_LABEL[field]}
                          >
                            <input
                              className="sheet-input"
                              type="text"
                              enterKeyHint="next"
                              inputMode={TEXT_FIELDS.includes(field) ? undefined : 'decimal'}
                              list={
                                field === 'species'
                                  ? 'dict-species'
                                  : field === 'grade'
                                    ? 'dict-grade'
                                    : undefined
                              }
                              value={row[field]}
                              onChange={(event) =>
                                updateRow(row.key, field, event.target.value)
                              }
                              onBlur={
                                field === 'baleLabel'
                                  ? () => void checkRowBaleNo(row.key)
                                  : undefined
                              }
                            />
                          </td>
                        ))}
                        <td className="col-unit num col-more">
                          {filler ? '' : formatCubic(row.cubic)}
                        </td>
                        <td className="col-unit col-more">{filler ? '' : 'm³'}</td>
                        <td className="col-third" data-label="单价">
                          <input
                            className="sheet-input num"
                            type="text"
                            inputMode="decimal"
                            enterKeyHint="next"
                            value={row.unitPrice}
                            onChange={(event) =>
                              updateRow(row.key, 'unitPrice', event.target.value)
                            }
                          />
                        </td>
                        {money && (
                          <td className="num col-more">
                            {filler ? '' : formatAmount(row.amount)}
                          </td>
                        )}
                        <td className="col-code muted col-more">
                          {filler ? '' : '自动生成'}
                        </td>
                      </tr>
                      {reasons.length > 0 && (
                        <tr className="is-error">
                          <td colSpan={sheetColCount} className="row-error">
                            {reasons.join('；')}
                          </td>
                        </tr>
                      )}
                      {hint && reasons.length === 0 && (
                        <tr>
                          <td colSpan={sheetColCount} className="row-hint">
                            该规格已有库存 {formatCubic(hint.cubic)} 立方 / {hint.bundles} 件
                          </td>
                        </tr>
                      )}
                      {/* 混装包：把「这行会被拆成几段、总立方多少」当场说清楚 */}
                      {row.cubic > 0 && slashSegments(row).length > 1 && (
                        <tr>
                          <td colSpan={sheetColCount} className="row-hint">
                            混装包：将拆成 {slashSegments(row).length} 段（
                            {slashSegments(row)
                              .map((seg) => `${seg.meters}m×${seg.pieces}片`)
                              .join('，')}
                            ），这一行合计 {formatCubic(row.cubic)} 立方 × {row.bundles || 1} 件
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td
                    colSpan={sheetColCount - tailCells.length}
                    className="sheet-total-label"
                  >
                    合计
                  </td>
                  {tailCells.map((cell) => (
                    <td key={cell.key} className={cell.className}>
                      {cell.value}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>

          <h2 className="form-section">备注</h2>
          <textarea
            className="input textarea sheet-note"
            placeholder="备注（选填）"
            value={form.remark}
            onChange={(event) => setForm((prev) => ({ ...prev, remark: event.target.value }))}
          />

          {/* 表下方：提单 / 合同 / 仓库 / 操作员 / 车号 */}
          <div className="sheet-bottom">
            <label className="sheet-field">
              <span>
                提单号{!legacyNoBl && <b className="req">*</b>}
              </span>
              <input
                data-field="blNo"
                className="input"
                enterKeyHint="next"
                placeholder="例如：BL-2026-0001"
                list="shipment-options"
                value={form.blNo}
                onChange={(event) => {
                  const value = event.target.value
                  setForm((prev) => ({ ...prev, blNo: value }))
                  // 手输时不打断输入；失焦（下面 onBlur）再解析是不是已有提单
                  if (shipmentId) setShipmentId(0)
                  // 号改了，上一个号的提示立刻作废（别挂着别人的单号）
                  if (blHint) setBlHint(null)
                }}
                onBlur={() => {
                  setShipmentId(matchShipmentId(form.blNo))
                  scheduleBlCheck(form.blNo, editing?.id)
                }}
              />
              <datalist id="shipment-options">
                {shipmentOptions.map((box) => (
                  <option key={box.id} value={box.bl_no} />
                ))}
              </datalist>
              <small className="muted">
                {legacyNoBl
                  ? '这张老单据入库时没填提单号，可以继续留空保存（新建单据必填）'
                  : '填过的提单号下次会自动带出；填了就归到那张提单下'}
              </small>
              {/* 这个号下已经有活单 → 就地提示 + 一键去那张单追加 */}
              {blHint && (
                <small className="bl-hint">
                  这个提单号已经有入库单 <b>{blHint.order_no}</b>
                  （已入 {formatCubic(blHint.cubic)} 方）。
                  {canWrite && (
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => navigate(`/inbound/edit/${blHint.id}`)}
                    >
                      去编辑那张单
                    </button>
                  )}
                </small>
              )}
            </label>
            <label className="sheet-field">
              <span>
                合同号
                {method === 'contract' && pickedContract ? '（来自所选采购合同）' : ''}
              </span>
              <input
                className="input"
                list={method === 'contract' && pickedContract ? undefined : 'contract-options'}
                placeholder="可从已有合同里选，也可手填"
                value={form.contractNo}
                readOnly={method === 'contract' && !!pickedContract}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, contractNo: event.target.value }))
                }
              />
            </label>
            <label className="sheet-field">
              <span>
                仓库<b className="req">*</b>
              </span>
              <input
                data-field="warehouse"
                className="input"
                enterKeyHint="next"
                placeholder="例如：一号仓"
                value={form.warehouse}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, warehouse: event.target.value }))
                }
              />
            </label>
            {/* 不常用的两项收进「更多信息」：手机上默认收起，桌面端照常平铺 */}
            <div className={moreOpen ? 'form-more is-open' : 'form-more'}>
              <label className="sheet-field">
                <span>操作员</span>
                <input
                  className="input"
                  placeholder="选填"
                  value={form.operator}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, operator: event.target.value }))
                  }
                />
              </label>
              {/* 柜数按明细里的柜号自动统计，不用手填 */}
              <label className="sheet-field">
                <span>柜数（自动统计）</span>
                <input
                  className="input input-readonly"
                  readOnly
                  value={`${boxCount} 个柜`}
                />
              </label>
            </div>
            <button
              type="button"
              className="form-more-toggle"
              onClick={() => setMoreOpen((open) => !open)}
            >
              {moreOpen ? '收起更多信息' : '更多信息（操作员 / 柜数）'}
            </button>
          </div>

          <p className="hint">
            包号照货上写的填（可留空）；一包混了几个规格时，把那几行的包号填成同一个号，系统并成一张码单。
            件数就是包数，单价必填。
            {editing ? ' 正在修改老单据：单号不变，库存按差异自动调整。' : ''}
          </p>
          {editing && (
            <p className="hint" style={{ color: '#b26a00' }}>
              改动包号 / 柜号 / 规格会重建这张单的码单；保存后条码号会重新按提单顺序编号，
              已打印的标签会失效。
            </p>
          )}
        </div>
      )}

      {(detail || detailLoading || detailError) && (
        <div className="overlay" onClick={closeDetail}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h2 className="modal-title">
                入库单详情{detail ? `：${detail.order_no}` : ''}
              </h2>
              <div className="modal-actions">
                {detail && (
                  <>
                    {canWrite && (
                      <>
                        <button
                          className="btn btn-sm"
                          onClick={() => {
                            closeDetail()
                            navigate(`/inbound/edit/${detail.id}`)
                          }}
                        >
                          编辑
                        </button>
                        <button
                          className="btn btn-sm btn-danger"
                          title="移入回收站，可在回收站恢复"
                          onClick={() =>
                            setDeleteTarget({
                              id: detail.id,
                              order_no: detail.order_no,
                            })
                          }
                        >
                          移入回收站
                        </button>
                      </>
                    )}
                  </>
                )}
                <button className="btn btn-quiet" onClick={closeDetail}>
                  关闭
                </button>
              </div>
            </div>

            {detailLoading && <p className="muted">加载中…</p>}

            {detail && (
              <>
                <div className="meta">
                  <span>供应商：{detail.supplier}</span>
                  <span>日期：{detail.order_date}</span>
                  <span>仓库：{detail.warehouse || '—'}</span>
                  <span>操作员：{detail.operator || '—'}</span>
                  <span>提单号：{detail.bl_no || '—'}</span>
                  <span>
                    合同号：
                    {detail.contract_no ? (
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() =>
                          void handleOpenContract(
                            detail.contract_id ?? 0,
                            detail.contract_no ?? '',
                          )
                        }
                        disabled={!detail.contract_id}
                      >
                        {detail.contract_no}
                      </button>
                    ) : (
                      '—'
                    )}
                  </span>
                  <span>备注：{detail.remark || '—'}</span>
                  <span>创建时间：{detail.created_at}</span>
                </div>

                <h3 className="section-title" style={{ marginTop: 4 }}>
                  入库明细（{detail.items.length} 行 · 合计{' '}
                  {formatCubic(detail.total_cubic)} m³
                  {money ? ` / ${formatAmount(detail.total_amount)} 元）` : '）'}
                </h3>
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
                      <th className="num">件数</th>
                      <th className="num">立方 (m³)</th>
                      {money && <th className="num">单价 (元)</th>}
                      {money && <th className="num">金额 (元)</th>}
                      <th>包号</th>
                      <th>柜号</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mergeItemsByBale(detail.items).map((group) => {
                      const first = group[0]
                      const cubic = group.reduce((sum, row) => sum + (row.cubic ?? 0), 0)
                      const amount = group.reduce((sum, row) => sum + (row.amount ?? 0), 0)
                      return (
                        <tr key={group.map((row) => row.id).join('-')}>
                          <td>{first.brand || '—'}</td>
                          <td>{first.species}</td>
                          <td>{first.grade || '—'}</td>
                          <td className="num">{first.thickness}</td>
                          <td className="num">{first.width}</td>
                          {/* 混装包：这几段合成一行，长度 / 片数写斜杠串 */}
                          <td className="num">{group.map((row) => row.length).join('/')}</td>
                          <td className="num">{group.map((row) => row.pieces).join('/')}</td>
                          <td className="num">{first.bundles}</td>
                          <td className="num">{formatCubic(cubic)}</td>
                          {money && (
                            <td className="num">{formatAmount(first.unit_price ?? 0)}</td>
                          )}
                          {money && <td className="num strong">{formatAmount(amount)}</td>}
                          <td>{first.bale_no || (first.bale_labels ?? []).join('、') || '—'}</td>
                          <td>{first.box_no || '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      {/* 领先列：品牌 / 品名 / 等级 / 厚度 / 宽度 / 长度 / 片数 / 件数 */}
                      <td colSpan={8}>合计</td>
                      <td className="num strong">{formatCubic(detail.total_cubic)}</td>
                      {money && <td />}
                      {money && (
                        <td className="num strong">{formatAmount(detail.total_amount)}</td>
                      )}
                      {/* 包号 / 柜号 */}
                      <td colSpan={2} />
                    </tr>
                  </tfoot>
                </table>

                {detail.bales && detail.bales.length > 0 ? (
                  <>
                    <h3 className="section-title" style={{ marginTop: 4 }}>
                      码单明细（{detail.bales.length} 包 · 在库{' '}
                      {detail.bales.filter((bale) => bale.status === 'in_stock').length} · 已出{' '}
                      {detail.bales.filter((bale) => bale.status === 'shipped').length}）
                    </h3>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>包号</th>
                          <th>条码号</th>
                          <th>柜号</th>
                          <th>品名</th>
                          <th>等级</th>
                          <th className="num">厚度 (mm)</th>
                          <th className="num">宽度 (mm)</th>
                          <th className="num">长度 (m)</th>
                          <th className="num">片数</th>
                          <th className="num">立方</th>
                          <th>状态</th>
                          <th>出库单</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.bales.map((bale) => (
                          <tr key={bale.id ?? bale.barcode ?? bale.bale_no}>
                            <td>{bale.bale_no || '—'}</td>
                            <td>{bale.barcode || '—'}</td>
                            <td>{bale.box_no || '—'}</td>
                            <td>{bale.species}</td>
                            <td>{bale.grade || '—'}</td>
                            {/* 混装包：长度 / 片数写斜杠串（别拿第一段 + 片数合计糊弄） */}
                            <td className="num">{bale.thickness}</td>
                            <td className="num">{bale.width}</td>
                            <td className="num">{bale.length_text ?? bale.length}</td>
                            <td className="num">{bale.pieces_text ?? bale.pieces}</td>
                            {/*
                              跨单合并包只挂在主单下：整包 8 方、其中本单 3 方。
                              本单那份小于整包时显示「3 / 8」（本单 / 总），鼠标悬停说清差额；
                              普通包（两个数相等）还是一个数字，和以前一样。
                            */}
                            <td className="num">
                              {bale.own_cubic < bale.cubic ? (
                                <span
                                  title={
                                    `这一包 ${formatCubic(bale.cubic)} 方，` +
                                    `其中 ${formatCubic(bale.own_cubic)} 方来自本单，` +
                                    `${formatCubic(roundTo(bale.cubic - bale.own_cubic, 4))} 方来自其他入库单`
                                  }
                                >
                                  {formatCubic(bale.own_cubic)} / {formatCubic(bale.cubic)}
                                </span>
                              ) : (
                                formatCubic(bale.cubic)
                              )}
                            </td>
                            <td>
                              <span
                                className={
                                  bale.status === 'in_stock' ? 'tag tag-in' : 'tag tag-out'
                                }
                              >
                                {bale.status === 'in_stock' ? '在库' : '已出库'}
                              </span>
                            </td>
                            <td>{bale.outbound_order_no || '—'}</td>
                            <td>
                              <button
                                className="btn btn-sm"
                                onClick={() => navigate(`/label/print?ids=${bale.id}`)}
                              >
                                打印标签
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                ) : (
                  <p className="muted" style={{ marginTop: 10 }}>
                    这张单下面还没有码单。
                  </p>
                )}

              </>
            )}
          </div>
        </div>
      )}

      {/* 这个提单号已经有活单：让用户选「去那张单追加」「仍要新建」「取消」 */}
      {blConflict && (
        <div className="overlay" onClick={() => setBlConflict(null)}>
          <div
            className="modal modal-narrow modal-alert"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="modal-title">这个提单号已经有入库单</h2>
            <p className="confirm-text">{blConflict.message}</p>
            <div className="confirm-actions">
              {blConflict.order && (
                <button
                  className="btn"
                  onClick={() => {
                    const id = blConflict.order?.id
                    setBlConflict(null)
                    if (id) navigate(`/inbound/edit/${id}`)
                  }}
                >
                  去编辑那张单
                </button>
              )}
              <button
                className="btn btn-primary"
                onClick={() => {
                  setBlConflict(null)
                  // 带 force 重发同一份表单
                  void handleSave(true)
                }}
              >
                仍要新建
              </button>
              <button className="btn" onClick={() => setBlConflict(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="overlay" onClick={() => setDeleteTarget(null)}>
          <div
            className="modal modal-narrow modal-alert"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="modal-title">移入回收站</h2>
            <p className="confirm-text">
              确认把入库单 {deleteTarget.order_no} 移入回收站？
              <br />
              库存会退出，之后可以在「回收站」里恢复。
            </p>
            <div className="confirm-actions">
              <button
                className="btn"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
              >
                取消
              </button>
              <button
                className="btn btn-danger-solid"
                onClick={() => void confirmDelete()}
                disabled={deleting}
              >
                {deleting ? '处理中…' : '移入回收站'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 关联采购合同：大页面按合同明细挑，比只给一个合同号下拉好选 */}
      {pickerOpen && (
        <div className="overlay" onClick={() => setPickerOpen(false)}>
          <div
            className="modal modal-xwide modal-sheet"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <h2 className="modal-title">选择采购合同</h2>
              <button className="btn btn-sm btn-quiet" onClick={() => setPickerOpen(false)}>
                关闭
              </button>
            </div>

            <div className="toolbar">
              <input
                className="input input-wide"
                placeholder="合同号 / 合同名称 / 供应商"
                title="合同号 / 合同名称 / 供应商"
                value={pickerKeyword}
                onChange={(event) => setPickerKeyword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    setPickerOffset(0)
                    void loadPicker(pickerKeyword, 0)
                  }
                }}
              />
              <button
                className="btn"
                onClick={() => {
                  setPickerOffset(0)
                  void loadPicker(pickerKeyword, 0)
                }}
              >
                查询
              </button>
              <button
                className="btn"
                onClick={() => {
                  setPickerKeyword('')
                  setPickerOffset(0)
                  void loadPicker('', 0)
                }}
              >
                重置
              </button>
            </div>

            <table className="table">
              <thead>
                <tr>
                  <th>选择</th>
                  <th>合同号</th>
                  <th>日期</th>
                  <th>供应商</th>
                  <th>品名</th>
                  <th>品牌</th>
                  <th className="num">合同立方 (m³)</th>
                  <th className="num">已入库 (m³)</th>
                  <th className="num">未到货 (m³)</th>
                  <th>单据状态</th>
                  <th>关联单号</th>
                </tr>
              </thead>
              <tbody>
                {pickerRows.map((row) => (
                  <tr
                    key={row.id}
                    className={pickerPick?.id === row.id ? 'row-active' : undefined}
                    onClick={() => {
                      setPickerPick(row)
                      if (pickerError) setPickerError('')
                    }}
                  >
                    <td>
                      <input
                        type="checkbox"
                        checked={pickerPick?.id === row.id}
                        onChange={() => {
                          setPickerPick(row)
                          if (pickerError) setPickerError('')
                        }}
                      />
                    </td>
                    <td>{row.contract_no}</td>
                    <td>{row.sign_date || '—'}</td>
                    <td>{row.partner || '—'}</td>
                    <td>{row.species_text || '—'}</td>
                    <td>{row.brand_text || '—'}</td>
                    <td className="num">{formatCubic(row.total_qty)}</td>
                    <td className="num">{formatCubic(row.in_cubic)}</td>
                    <td className="num">{formatCubic(row.left_cubic)}</td>
                    <td>
                      <span className={row.status === '全部发货' ? 'tag tag-in' : 'tag tag-out'}>
                        {row.status}
                      </span>
                    </td>
                    <td>
                      {row.orders.length === 0 ? (
                        '—'
                      ) : (
                        <div className="row-actions">
                          {row.orders.map((order) => (
                            <button
                              key={order.id}
                              type="button"
                              className="link-btn"
                              title="点一下去改这张入库单"
                              onClick={(event) => {
                                event.stopPropagation()
                                setPickerOpen(false)
                                navigate(`/inbound/edit/${order.id}`)
                              }}
                            >
                              {order.order_no}
                            </button>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {!pickerLoading && pickerRows.length === 0 && (
              <EmptyState text="没有符合条件的合同，先到「采购合同」页新建合同" />
            )}
            {pickerLoading && <Loading />}

            {pickerError && <p className="login-error">{pickerError}</p>}

            <Pager
              total={pickerTotal}
              limit={PICKER_PAGE_SIZE}
              offset={pickerOffset}
              onChange={(next) => {
                setPickerOffset(next)
                void loadPicker(pickerKeyword, next)
              }}
              unit="份合同"
            />

            <div className="confirm-actions">
              <button className="btn" onClick={() => setPickerOpen(false)}>
                取消
              </button>
              <button className="btn btn-primary" onClick={confirmPick}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
