import {
  Fragment,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  createOutbound,
  deleteOutbound,
  purgeRecycleOrder,
  restoreRecycleOrder,
  downloadFile,
  fetchOutboundDetail,
  fetchOutboundList,
  fetchBaleDetail,
  fetchBales,
  fetchStock,
  outboundExportUrl,
  scanOutboundBale,
  updateOutbound,
  type InboundItemPayload,
  type BaleRow,
  type OutboundDetail,
  type OutboundListFilters,
  type OutboundListItem,
  type StockSnapshot,
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

// 扫码库挺大，点「扫一扫」才去下载
const Scanner = lazy(() => import('../components/Scanner'))
import { toNumber, roundTo, formatCubic, formatAmount, todayISO } from '../utils/num'
import { tapFeedback, tapHeavy, tapMedium } from '../utils/haptics'
import { usePullToRefresh } from '../hooks/usePullToRefresh'
import { useKeyboardScroll } from '../hooks/useKeyboardScroll'
import { readRecentSpecs, rememberSpecs, type RecentSpec } from '../utils/recentSpecs'
import { enterToNext } from '../utils/formNav'
import { readListCache, writeListCache } from '../utils/listCache'
import { useOnline } from '../hooks/useOnline'
import { isNetworkError } from '../utils/network'
import { useRole } from '../hooks/useRole'
import { seesMoney } from '../permissions'
import { can } from '../permissions'
import SuccessToast from '../components/SuccessToast'

/* ---------- 立方预览：与 server/utils/cubic.js 同一公式 ---------- */

const CUBIC_DIVISOR = 1000000
const EPSILON = 1e-9

const previewCubic = (row: FormRow) =>
  roundTo(
    (toNumber(row.thickness) *
      toNumber(row.width) *
      toNumber(row.length) *
      toNumber(row.pieces) *
      toNumber(row.bundles)) /
      CUBIC_DIVISOR,
    4,
  )

const previewAmount = (cubic: number, unitPrice: string) =>
  roundTo(cubic * toNumber(unitPrice), 2)

/* ---------- 明细行 ---------- */

type FormRow = {
  key: number
  species: string
  grade: string
  thickness: string
  width: string
  length: string
  pieces: string
  bundles: string
  unitPrice: string
  /** 按码单发货时带上码单 id 和码单号 */
  baleId?: number
  baleNo?: string
  /** 条码号（就是码单，要打印贴包上） */
  baleBarcode?: string
  /**
   * 这一行的立方直接锁死（来自码单时用）。
   * 混装包的长度 / 片数是斜杠串（`1.8/2.1/2.4`、`17/30/247`），
   * 乘不出来，所以立方直接用这一包的合计值，别重算。
   * undefined = 手工行，照常按 厚×宽×长×片数 算。
   */
  cubicLocked?: number
}

let rowSeq = 0

const createRow = (): FormRow => ({
  key: (rowSeq += 1),
  species: '',
  grade: '',
  thickness: '',
  width: '',
  length: '',
  pieces: '1',
  bundles: '1',
  unitPrice: '',
})

const isRowEmpty = (row: FormRow) =>
  !row.species.trim() &&
  !row.grade.trim() &&
  !row.thickness.trim() &&
  !row.width.trim() &&
  !row.length.trim() &&
  !row.unitPrice.trim()

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

  /**
   * 绑了码单的行：规格 / 片数是这一包的原文 —— 混装包在这里写的是斜杠串
   * （`1.8/2.1/2.4`、`17/30/247`），拿 toNumber 去比必然过不了，
   * 混装包就永远发不出去。这一行真正要出库的规格由后端按 bale_items 展开，
   * 所以这里只校验「出几件、什么价」。
   */
  if (row.baleId) {
    if (!(Number.isInteger(bundles) && bundles > 0)) reasons.push('件数必须是大于 0 的整数')
    if (!(toNumber(row.unitPrice) > 0)) reasons.push('单价必填，且必须大于 0')
    return reasons
  }

  if (!row.species.trim()) reasons.push('请先点左侧「选择规格」')

  if (thickness <= 0) reasons.push('厚度必须大于 0mm')
  else if (thickness > MAX_THICKNESS) reasons.push(`厚度不能超过 ${MAX_THICKNESS}mm`)

  if (width <= 0) reasons.push('宽度必须大于 0mm')
  else if (width > MAX_WIDTH) reasons.push(`宽度不能超过 ${MAX_WIDTH}mm`)

  if (length <= 0) reasons.push('长度必须大于 0m')
  else if (length > MAX_LENGTH) reasons.push(`长度不能超过 ${MAX_LENGTH}m`)

  if (!(Number.isInteger(pieces) && pieces > 0)) reasons.push('片数必须是大于 0 的整数')
  if (!(Number.isInteger(bundles) && bundles > 0)) reasons.push('件数必须是大于 0 的整数')
  if (!(toNumber(row.unitPrice) > 0)) reasons.push('单价必填，且必须大于 0')

  return reasons
}

// 整行留空的行会被忽略、不提交，因此也不参与校验
function validateRows(rows: FormRow[]): Record<number, string[]> {
  const errors: Record<number, string[]> = {}
  for (const row of rows) {
    if (isRowEmpty(row)) continue
    const reasons = validateRow(row)
    if (reasons.length > 0) errors[row.key] = reasons
  }
  return errors
}

// 规格键：与后端 species + grade + thickness + width + length 归组口径一致
const specKeyOf = (row: FormRow) => {
  const species = row.species.trim()
  const thickness = toNumber(row.thickness)
  const width = toNumber(row.width)
  const length = toNumber(row.length)
  if (!species || thickness <= 0 || width <= 0 || length <= 0) return ''
  return [species, row.grade.trim(), thickness, width, length].join('|')
}

const emptyFilters: OutboundListFilters = {}

const emptyInput = {
  order_no: '',
  customer: '',
  warehouse: '',
  operator: '',
  date_from: '',
  date_to: '',
}

const PAGE_SIZE = 20

/* ---------- 样式 ---------- */


// 规格相关的 5 个字段由「选择规格」弹窗填充，不允许手输
const specFields: { field: keyof Omit<FormRow, 'key'>; label: string }[] = [
  { field: 'species', label: '品名' },
  { field: 'grade', label: '等级' },
  { field: 'thickness', label: '厚度' },
  { field: 'width', label: '宽度' },
  { field: 'length', label: '长度' },
]

// 需要用户自己填的字段
const numberFields: { field: keyof Omit<FormRow, 'key'>; label: string }[] = [
  { field: 'pieces', label: '片数' },
  { field: 'bundles', label: '件数' },
  { field: 'unitPrice', label: '单价*' },
]

// 表格总列数：序号 + 勾选 + 操作 + 条码号 + 包号 + 规格 + 数量列 + 立方/单位/金额/库存
const SHEET_COLUMNS = 3 + 2 + specFields.length + numberFields.length + 4

export default function Outbound({
  defaultMode = 'list',
}: {
  /** /outbound/new 直接进录入表单，/outbound 先看列表 */
  defaultMode?: 'list' | 'create'
}) {
  const [mode, setMode] = useState<'list' | 'create'>(defaultMode)
  const navigate = useNavigate()
  /** 回列表并把地址栏一起归位（/outbound/new 保存完还停着的话，刷新会又开一张空白单） */
  const backToList = () => {
    setMode('list')
    setEditing(null)
    if (defaultMode !== 'list') navigate('/outbound', { replace: true })
  }

  /**
   * 看不到金额的角色（业务员 / 仓管）：
   *   - 明细表的「金额(元)」列、合计里的金额、详情里的单价/金额都不显示；
   *   - 「单价(元)」输入框**保留** —— 方案 A：录单的人得自己填；
   *   - 改单时前端拿不到原价，后端会把对得上的行原价补回去，不会清成 0。
   * 明细总列数跟着少一列，出错提示行的 colspan 用的是同一个数。
   */
  const money = seesMoney(useRole())
  const sheetColumns = SHEET_COLUMNS - (money ? 0 : 1)
  /** 只读角色不给录入入口 */
  const canWrite = can(useRole(), 'outbound.write')

  // 非空 = 正在修改这张单（单号不变，只替换明细）
  const [editing, setEditing] = useState<{ id: number; order_no: string } | null>(null)

  const [list, setList] = useState<OutboundListItem[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState('')
  const [notice, setNotice] = useState('')
  const [success, setSuccess] = useState<{ title: string; subtitle: string } | null>(null)
  /** 提示条里的「撤销」（保存/删除刚做完 3 秒内有效） */
  const [undo, setUndo] = useState<{ label: string; run: () => void } | null>(null)
  /** 后台静默刷新中 */
  const [listRefreshing, setListRefreshing] = useState(false)
  /** 保存失败后可以「重试」的那一下 */
  const [retrySave, setRetrySave] = useState<null | (() => void)>(null)
  /** 离线时禁用保存 */
  const online = useOnline()

  // 客户候选：从已录过的单里取，录单时可以直接选
  const customerOptions = useMemo(
    () =>
      Array.from(
        new Set(list.map((item) => (item.customer ?? '').trim()).filter(Boolean)),
      ),
    [list],
  )

  const [input, setInput] = useState(emptyInput)
  const [filters, setFilters] = useState<OutboundListFilters>(emptyFilters)
  /** 手机端：筛选字段收进底部 sheet */
  const [filterOpen, setFilterOpen] = useState(false)
  /** 手机端左滑：露出「编辑 / 移入回收站」 */
  const [swipedId, setSwipedId] = useState<number | null>(null)
  const swipeStartX = useRef(0)
  /** 常用规格（本机记的）：点一下打开选码单并只看这个规格的包 */
  const [recentSpecs, setRecentSpecs] = useState<RecentSpec[]>(() => readRecentSpecs())
  const [specFilter, setSpecFilter] = useState<RecentSpec | null>(null)
  const activeFilterCount = [
    filters.customer,
    filters.warehouse,
    filters.operator,
    filters.date_from,
    filters.date_to,
  ].filter(Boolean).length
  const { distance: pullDistance, busy: pullBusy } = usePullToRefresh(
    () => loadList(filters, offset),
    mode === 'list',
  )

  /** 键盘弹出来时把正在填的框顶到键盘上面 */
  useKeyboardScroll(mode !== 'list')
  const [offset, setOffset] = useState(0)
  const [total, setTotal] = useState(0)
  const [reloadToken, setReloadToken] = useState(0)

  const [detail, setDetail] = useState<OutboundDetail | null>(null)
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
    customer: '',
    orderDate: todayISO(),
    // remark 保留在表单里但不再显示：编辑老单据时不能把已有的备注抹掉
    remark: '',
    warehouse: '',
    operator: '',
    vehicleNo: '',
  })
  const [rows, setRows] = useState<FormRow[]>(() => [createRow()])
  // 表格左侧勾选的行（批量删除用）
  const [pickedRows, setPickedRows] = useState<number[]>([])
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [rowErrors, setRowErrors] = useState<Record<number, string[]>>({})
  /** 手机端哪些明细行点了「更多」（展开条码号/数量/单位/金额这些次要字段） */
  const [expandedRows, setExpandedRows] = useState<number[]>([])
  const [hasValidated, setHasValidated] = useState(false)

  // 规格选择弹窗
  const [pickerRowKey, setPickerRowKey] = useState<number | null>(null)
  const [pickerBales, setPickerBales] = useState<BaleRow[]>([])
  const [pickedBaleIds, setPickedBaleIds] = useState<number[]>([])
  // 选包弹窗的用途：multi = 多选（「选择码单」），one = 单选追加一行（「+ 新增」）
  const [pickerIntent, setPickerIntent] = useState<'multi' | 'one'>('multi')
  const [pickerKeyword, setPickerKeyword] = useState('')
  const [pickerLoading, setPickerLoading] = useState(false)
  // 确认选择时要先算每包的成本价（加权平均），算的时候把按钮锁住
  const [pickerApplying, setPickerApplying] = useState(false)
  const [pickerError, setPickerError] = useState('')
  // 扫码弹窗 + 扫到码之后的一句反馈
  const [scannerOpen, setScannerOpen] = useState(false)
  const [scanHint, setScanHint] = useState('')
  // 规格 -> 当前库存（实时提示用）
  const [stockMap, setStockMap] = useState<Record<string, StockSnapshot>>({})
  const requestedSpecs = useRef<Set<string>>(new Set())

  /**
   * 首页宫格的「扫码」落到 /outbound/new?scan=1：
   * 进来就把扫码弹窗打开（仓管少点「进出库 → 扫一扫」这两下）。
   * 参数读完立刻清掉 —— 之后刷新、前进后退都不会再自动弹一次。
   */
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    if (searchParams.get('scan') !== '1') return
    setScanHint('')
    setScannerOpen(true)
    const next = new URLSearchParams(searchParams)
    next.delete('scan')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  // 详情弹层的关闭入口统一走这里，Esc / 点遮罩 / 关闭按钮行为一致
  const closeDetail = useCallback(() => {
    setDetail(null)
    setDetailError('')
    setDetailLoading(false)
  }, [])

  // Esc 只关最上面那层：规格选择 > 删除确认 > 详情
  useEscapeKey(pickerRowKey !== null, () => setPickerRowKey(null))
  useEscapeKey(
    pickerRowKey === null && Boolean(deleteTarget) && !deleting,
    () => setDeleteTarget(null),
  )
  useEscapeKey(
    pickerRowKey === null &&
      !deleteTarget &&
      Boolean(detail || detailLoading || detailError),
    closeDetail,
  )

  const loadList = useCallback(
    async (nextFilters: OutboundListFilters, nextOffset: number) => {
      // 有缓存先渲染（不闪空白），再后台静默刷新；没缓存才给骨架
      const cacheKey = `outbound:${JSON.stringify(nextFilters)}:${nextOffset}`
      const cached = readListCache<{ rows: OutboundListItem[]; total: number }>(cacheKey)
      if (cached) {
        setList(cached.rows)
        setTotal(cached.total)
        setListRefreshing(true)
      } else {
        setListLoading(true)
      }
      setListError('')
      try {
        const result = await fetchOutboundList({
          ...nextFilters,
          limit: PAGE_SIZE,
          offset: nextOffset,
        })
        setList(result.rows)
        setTotal(result.total)
        writeListCache(cacheKey, { rows: result.rows, total: result.total })
      } catch (err) {
        setListError(err instanceof Error ? err.message : '加载失败')
      } finally {
        setListLoading(false)
        setListRefreshing(false)
      }
    },
    [],
  )

  useEffect(() => {
    void loadList(filters, offset)
  }, [loadList, filters, offset, reloadToken])

  // 首次点保存后转为实时校验：改一个字段就刷新标红结果
  useEffect(() => {
    if (!hasValidated) return
    setRowErrors(validateRows(rows))
  }, [rows, hasValidated])

  const computedRows = useMemo(
    () =>
      rows.map((row) => {
        // 码单带来的行立方是锁死的（斜杠串没法做乘法），手工行才实时算
        const cubic = row.cubicLocked !== undefined ? row.cubicLocked : previewCubic(row)
        return {
          ...row,
          specKey: specKeyOf(row),
          cubic,
          amount: previewAmount(cubic, row.unitPrice),
        }
      }),
    [rows],
  )

  // 规格填全后拉一次当前库存，填错改了规格会按新规格再拉
  useEffect(() => {
    const pending = new Map<string, FormRow>()
    for (const row of computedRows) {
      if (row.specKey && !requestedSpecs.current.has(row.specKey)) {
        pending.set(row.specKey, row)
      }
    }
    if (pending.size === 0) return

    let cancelled = false
    for (const [key, row] of pending) {
      requestedSpecs.current.add(key)
      void fetchStock({
        species: row.species.trim(),
        grade: row.grade.trim(),
        thickness: toNumber(row.thickness),
        width: toNumber(row.width),
        length: toNumber(row.length),
      })
        .then((stock) => {
          if (!cancelled) setStockMap((prev) => ({ ...prev, [key]: stock }))
        })
        .catch(() => {
          requestedSpecs.current.delete(key)
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
          pieces: acc.pieces + toNumber(row.pieces) * toNumber(row.bundles),
          bundles: acc.bundles + toNumber(row.bundles),
        }),
        { cubic: 0, amount: 0, pieces: 0, bundles: 0 },
      ),
    [computedRows],
  )

  const updateRow = (
    key: number,
    field: keyof Omit<FormRow, 'key'>,
    value: string,
  ) => {
    setRows((prev) =>
      prev.map((row) => (row.key === key ? { ...row, [field]: value } : row)),
    )
    // 改动后旧提示就过期了，清掉；行内标红由实时校验刷新
    if (formError) setFormError('')
  }

  const loadPickerRows = async (keyword: string) => {
    setPickerLoading(true)
    setPickerError('')
    try {
      // 出库是按包发的：这里列出「在库」的码单
      const page = await fetchBales({ status: 'in_stock', keyword, limit: 200 })
      setPickerBales(page.rows)
    } catch (err) {
      setPickerError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setPickerLoading(false)
    }
  }

  const openPicker = (intent: 'multi' | 'one') => {
    setPickerRowKey(0)
    setPickerIntent(intent)
    setPickerKeyword('')
    setPickerBales([])
    setPickedBaleIds([])
    setPickerError('')
    void loadPickerRows('')
  }

  /** 表格里已经绑过的码单 id（同一包不能重复出现在明细里） */
  const rowBaleIds = () =>
    new Set(
      rows
        .map((row) => row.baleId)
        .filter((id): id is number => typeof id === 'number'),
    )

  /**
   * 把选中的码单【追加】到明细里：每包一行，规格和立方由码单带出，
   * 单价默认带出这一包的成本价（加权平均），用户可以改。
   *
   * 注意是追加不是替换——先选 a1、再选 A5，两行都在；
   * 已经绑过的包会被跳过，表格里那行空占位也会在第一次追加时清掉。
   */
  const appendBales = async (picked: BaleRow[]) => {
    const already = rowBaleIds()
    const fresh = picked.filter((bale) => !already.has(bale.id))
    if (fresh.length === 0) {
      setPickerError('选中的码单已经在明细里了')
      return
    }

    setPickerApplying(true)
    try {
      /**
       * 每一包都拉一次规格行详情：
       *   - 混装包一包里有几段不同长度，**必须按每一段生成一行明细**；
       *     拿 bales 表的主规格（只有第一段的厚宽长）+ 片数合计拼一行，
       *     立方必然算错（比如实际 55.35 会算成 9.15），库存也就扣错了。
       *   - 顺便把成本价按立方加权算出来填进单价。
       */
      const details = await Promise.all(
        fresh.map((bale) => fetchBaleDetail(bale.id).catch(() => null)),
      )

      setRows((prev) => {
        // 只留已经选过货的行；初始那行空占位顺手丢掉，不留一条空行挡保存
        const kept = prev.filter(
          (row) => typeof row.baleId === 'number' || row.species.trim(),
        )
        const added: FormRow[] = []

        fresh.forEach((bale, index) => {
          const detail = details[index]
          // 拉不到详情就退化成「按主规格一行」，至少不会卡住
          const lines =
            detail && detail.items.length > 0
              ? detail.items
              : [
                  {
                    brand: '',
                    species: bale.species,
                    grade: bale.grade,
                    thickness: bale.thickness,
                    width: bale.width,
                    length: bale.length,
                    pieces: bale.pieces,
                    cubic: bale.cubic,
                    unit_price: null as number | null,
                  },
                ]

          const cubic = lines.reduce((sum, line) => sum + (line.cubic ?? 0), 0)
          const amount = lines.reduce(
            (sum, line) => sum + (line.cubic ?? 0) * (line.unit_price ?? 0),
            0,
          )
          const price = cubic > 0 ? roundTo(amount / cubic, 2) : 0

          /**
           * 一包 = 明细里**一行**。
           * 混装包的长度 / 片数写斜杠串（1.8/2.1/2.4、17/30/247），立方用这一包的合计值锁死；
           * 库里仍然按段落 order_items（见 server/routes/outbound.js 的 specRowsOf），库存才不会错。
           */
          added.push({
            key: (rowSeq += 1),
            species: bale.species,
            grade: bale.grade,
            thickness: String(bale.thickness),
            width: String(bale.width),
            length: bale.length_text || String(bale.length),
            pieces: bale.pieces_text || String(bale.pieces),
            bundles: '1',
            // 单价默认带出这一包的成本价（按立方加权），用户可以改
            unitPrice: price > 0 ? String(price) : '',
            baleId: bale.id,
            baleNo: bale.bale_no,
            baleBarcode: bale.barcode,
            cubicLocked: cubic > 0 ? cubic : bale.cubic,
          })
        })

        return [...kept, ...added]
      })
      setPickerRowKey(null)
      setPickedBaleIds([])
      setPickerError('')
      setFormError('')
    } finally {
      setPickerApplying(false)
    }
  }

  /** 「选择码单」确认：把勾选的包全部追加 */
  const applyBales = async () => {
    if (pickedBaleIds.length === 0) {
      setPickerError('请至少选择一个码单')
      return
    }
    await appendBales(pickerBales.filter((bale) => pickedBaleIds.includes(bale.id)))
  }

  /**
   * 扫到标签上的二维码（MZ|码单号|包号）：
   * 问后端这一包是谁 → 追加一行（同样是追加，不冲掉已有的行）。
   * 弹窗不自动关，方便工人一包一包连着扫。
   */
  const handleScan = async (code: string) => {
    try {
      const bale = await scanOutboundBale(code)
      if (rows.some((row) => row.baleId === bale.bale_id)) {
        setScanHint(`${bale.bale_no || bale.barcode} 已经在明细里了`)
        return
      }
      setRows((prev) => {
        const kept = prev.filter(
          (row) => typeof row.baleId === 'number' || row.species.trim(),
        )
        /**
         * 一包 = 一行（和「选择码单」一致）。
         * 混装包的长度 / 片数用斜杠串，立方用扫码接口返回的这一包合计值锁死。
         * 成本价：看不到金额的角色拿不到（后端不返回），留空让他们手填 ——
         * 注意不能写成 String(undefined)，那样会变成字符串 "undefined"。
         */
        const price = bale.unit_price
        return [
          ...kept,
          {
            key: (rowSeq += 1),
            species: bale.species,
            grade: bale.grade,
            thickness: String(bale.thickness),
            width: String(bale.width),
            length:
              bale.items && bale.items.length > 1
                ? bale.items.map((one) => one.length).join('/')
                : String(bale.length),
            pieces:
              bale.items && bale.items.length > 1
                ? bale.items.map((one) => one.pieces).join('/')
                : String(bale.pieces),
            bundles: '1',
            unitPrice:
              price === null || price === undefined ? '' : String(price),
            baleId: bale.bale_id,
            baleNo: bale.bale_no,
            baleBarcode: bale.barcode,
            cubicLocked: bale.cubic,
          },
        ]
      })
      setFormError('')
      setScanHint(
        `已加入 ${bale.bale_no || bale.barcode}（${formatCubic(bale.cubic)} m³）`,
      )
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '扫码失败')
    }
  }

  const removeRow = (key: number) => {
    // 只剩一行时不删：至少要留一行明细（按钮那边会置灰并给出提示）
    setRows((prev) => (prev.length > 1 ? prev.filter((row) => row.key !== key) : prev))
    setPickedRows((prev) => prev.filter((item) => item !== key))
    if (formError) setFormError('')
  }

  /** 删掉勾选的行 */
  const removePickedRows = () => {
    if (pickedRows.length === 0) return
    setRows((prev) => {
      const next = prev.filter((row) => !pickedRows.includes(row.key))
      return next.length > 0 ? next : [createRow()]
    })
    setPickedRows([])
    if (formError) setFormError('')
  }

  const handleSearch = () => {
    setNotice('')
    setOffset(0)
    setFilters({
      order_no: input.order_no.trim(),
      customer: input.customer.trim(),
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
        outboundExportUrl({
          customer: filters.customer,
          date_from: filters.date_from,
          date_to: filters.date_to,
        }),
        '出库明细.xlsx',
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
    setRowErrors({})
    setHasValidated(false)
    setForm({
      customer: '',
      orderDate: todayISO(),
      remark: '',
      warehouse: '',
      operator: '',
      vehicleNo: '',
    })
    setRows([createRow()])
    setMode('create')
  }

  // 修改：拉出原单明细填进同一套表单，保存时走 PUT，单号保持不变
  const openEdit = async (item: { id: number; order_no: string }) => {
    setNotice('')
    setFormError('')
    setActionError('')
    try {
      const data = await fetchOutboundDetail(item.id)
      setForm({
        customer: data.customer ?? '',
        orderDate: data.order_date ?? todayISO(),
        remark: data.remark ?? '',
        warehouse: data.warehouse ?? '',
        operator: data.operator ?? '',
        vehicleNo: data.vehicle_no ?? '',
      })
      setRows(
        data.items.map((line) => ({
          key: (rowSeq += 1),
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
      )
      setRowErrors({})
      setHasValidated(false)
      setEditing({ id: item.id, order_no: item.order_no })
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
      setDetail(await fetchOutboundDetail(id))
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
      await deleteOutbound(deleteTarget.id)
      setDeleteTarget(null)
      setDetail(null)
      const target = deleteTarget
      setNotice(`已撤销出库 ${target.order_no}，库存已回退`)
      // 撤销 = 把这张出库单从回收站恢复回来（库存会重新扣回去）
      setUndo({
        label: '撤销',
        run: () => {
          void (async () => {
            try {
              await restoreRecycleOrder('out', target.id)
              setNotice(`已恢复出库单 ${target.order_no}，库存已重新扣回`)
              requestedSpecs.current.clear()
              setStockMap({})
              setReloadToken((n) => n + 1)
            } catch (err) {
              setActionError(err instanceof Error ? err.message : '恢复失败')
            }
          })()
        },
      })
      // 出库单删掉后库存回涨，「当前库存」提示要重新取
      requestedSpecs.current.clear()
      setStockMap({})
      setReloadToken((n) => n + 1)
    } catch (err) {
      setDeleteTarget(null)
      setActionError(err instanceof Error ? err.message : '撤销出库失败')
    } finally {
      setDeleting(false)
    }
  }

  const handleSave = async (continueAfter = false) => {
    const customer = form.customer.trim()

    setHasValidated(true)
    const errors = validateRows(rows)
    setRowErrors(errors)
    setFormError('')

    if (!customer) {
      setFormError('客户不能为空')
      return
    }
    if (!form.warehouse.trim()) {
      setFormError('仓库不能为空')
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
      // 手机上滚到第一条出问题的行并聚焦（录了十几行时，光提示找不到）
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
      species: row.species.trim(),
      grade: row.grade.trim(),
      thickness: toNumber(row.thickness),
      width: toNumber(row.width),
      length: toNumber(row.length),
      pieces: toNumber(row.pieces),
      bundles: toNumber(row.bundles),
      unit_price: toNumber(row.unitPrice),
      /**
       * 这一行是从哪一包带出来的：服务端按包对账用
       * （Σ该包的明细立方 == 这一包的立方，对不上直接 400）。
       * 混装包一包多行，这几行的 bale_id 是同一个。
       */
      bale_id: row.baleId,
      bale_no: row.baleNo,
    }))
    // 发走的码单 id：混装包一包多行，去重后再发；服务端会再校验一遍是否都还在库
    const baleIds = [
      ...new Set(
        filledRows
          .map((row) => row.baleId)
          .filter((id): id is number => typeof id === 'number'),
      ),
    ]
    if (filledRows.some((row) => typeof row.baleId !== 'number')) {
      setFormError('有明细行没有选码单，请点「选择码单」重新挑选')
      return
    }

    setSaving(true)
    setFormError('')
    try {
      const payload = {
        customer,
        order_date: form.orderDate,
        remark: form.remark.trim(),
        warehouse: form.warehouse.trim(),
        operator: form.operator.trim(),
        vehicle_no: form.vehicleNo.trim(),
        items,
        bale_ids: baleIds,
      }
      const result = editing
        ? await updateOutbound(editing.id, payload)
        : await createOutbound(payload)
      setRecentSpecs(rememberSpecs(items))
      if (continueAfter) {
        /**
         * 「保存并继续」：留在表单录下一张 —— 客户 / 日期 / 仓库 / 操作员 保留，
         * 明细清空（出库明细都是从码单带出来的，下一张得重新挑）。
         */
        setRows([createRow()])
        setPickedRows([])
        setRowErrors({})
        setForm((prev) => ({ ...prev, remark: '', vehicleNo: '' }))
        requestedSpecs.current.clear()
        setStockMap({})
        setNotice(`已保存出库单 ${result.order_no}，可以接着录下一张`)
        setSuccess({
          title: '已出库',
          subtitle: `出库单 ${result.order_no} 保存成功`,
        })
        window.setTimeout(() => window.scrollTo({ top: 0, behavior: 'smooth' }), 60)
        return
      }
      // 回列表 + 地址栏归位（/outbound/new → /outbound）
      backToList()
      setForm({
        customer: '',
        orderDate: todayISO(),
        remark: '',
        warehouse: '',
        operator: '',
        vehicleNo: '',
      })
      setRows([createRow()])
      // 出库后库存变了，清掉缓存重新取
      requestedSpecs.current.clear()
      setStockMap({})
      // 清掉筛选并回到第一页，保证刚保存的单一定看得见
      setInput(emptyInput)
      setFilters(emptyFilters)
      setOffset(0)
      setReloadToken((n) => n + 1)
      setNotice(
        editing
          ? `已保存出库单 ${result.order_no} 的修改`
          : `已保存出库单 ${result.order_no}`,
      )
      setSuccess({
        title: '已出库',
        subtitle: `出库单 ${result.order_no} 保存成功`,
      })
      // 新建才给「撤销」：删掉刚建的那张（连回收站里也不留）
      setUndo(
        editing
          ? null
          : {
              label: '撤销',
              run: () => {
                void (async () => {
                  try {
                    await deleteOutbound(result.id)
                    await purgeRecycleOrder('out', result.id)
                    setNotice(`已撤销：出库单 ${result.order_no} 已删除，库存已回退`)
                    requestedSpecs.current.clear()
                    setStockMap({})
                    setReloadToken((n) => n + 1)
                  } catch (err) {
                    setActionError(err instanceof Error ? err.message : '撤销失败')
                  }
                })()
              },
            },
      )
    } catch (err) {
      // 后端返回的库存不足信息原样展示，不吞掉
      // 网络层错误给人话 + 「重试」；服务端业务错误（400/409）原样展示
      if (isNetworkError(err)) {
        setFormError('网络不可用，请检查网络后重试')
        setRetrySave(() => () => void handleSave(continueAfter))
      } else {
        setFormError(err instanceof Error ? err.message : '保存失败')
        setRetrySave(null)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <section>
      <PageHead
        title="出库"
        subtitle="从库存里挑规格出库，保存前会校验库存是否足够；支持按客户与日期查询"
        extra={
          <button className="btn" onClick={handleExport} disabled={exporting}>
            {exporting ? '导出中…' : '导出 Excel'}
          </button>
        }
      />

      <ToastHost
        items={[
          scanHint
            ? {
                id: 'outbound-scan-hint',
                kind: 'info' as const,
                message: scanHint,
                onClose: () => setScanHint(''),
              }
            : null,
          exportHint
            ? {
                id: 'outbound-export-hint',
                kind: 'info' as const,
                message: exportHint,
                onClose: () => setExportHint(''),
              }
            : null,
          notice
            ? {
                id: 'outbound-notice',
                kind: 'success' as const,
                message: notice,
                onClose: () => {
                  setNotice('')
                  setUndo(null)
                },
                actionLabel: undo?.label,
                onAction: undo?.run,
              }
            : null,
          actionError
            ? {
                id: 'outbound-action-error',
                kind: 'error' as const,
                message: actionError,
                onClose: () => setActionError(''),
              }
            : null,
          listError
            ? {
                id: 'outbound-list-error',
                kind: 'error' as const,
                message: listError,
                onClose: () => setListError(''),
              }
            : null,
          formError
            ? {
                id: 'outbound-form-error',
                kind: 'error' as const,
                message: formError,
                onClose: () => {
                  setFormError('')
                  setRetrySave(null)
                },
                actionLabel: retrySave ? '重试' : undefined,
                onAction: retrySave ?? undefined,
              }
            : null,
          detailError
            ? {
                id: 'outbound-detail-error',
                kind: 'error' as const,
                message: detailError,
                onClose: () => setDetailError(''),
              }
            : null,
          pickerError
            ? {
                id: 'outbound-picker-error',
                kind: 'error' as const,
                message: pickerError,
                onClose: () => setPickerError(''),
              }
            : null,
        ]}
      />
      <SuccessToast
        open={Boolean(success)}
        title={success?.title ?? ''}
        subtitle={success?.subtitle ?? ''}
        onDone={() => setSuccess(null)}
      />

      {mode === 'list' ? (
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
              placeholder="客户关键字"
              value={input.customer}
              onChange={(event) =>
                setInput((prev) => ({ ...prev, customer: event.target.value }))
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
            <button className="btn" onClick={handleSearch}>
              查询
            </button>
              <div className="filter-sheet-actions">
                <button className="btn" onClick={handleResetFilters}>
                  重置
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    handleSearch()
                    setFilterOpen(false)
                  }}
                >
                  查询
                </button>
              </div>
            </div>
            {filterOpen && (
              <div className="filter-sheet-mask" onClick={() => setFilterOpen(false)} />
            )}
            <span className="spacer" />
            {listRefreshing && <span className="list-refreshing">刷新中…</span>}
            {canWrite && (
              <button className="btn btn-primary" onClick={openCreate}>
                新增出库
              </button>
            )}
          </div>

          <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>单号</th>
                <th>客户</th>
                <th>日期</th>
                <th>状态</th>
                <th>仓库</th>
                <th>操作员</th>
                <th className="num">总立方</th>
                {money && <th className="num">总金额</th>}
                <th className="num">明细数</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((order) => (
                <tr
                  key={order.id}
                  className={swipedId === order.id ? 'is-swiped' : undefined}
                  onTouchStart={(event) => {
                    swipeStartX.current = event.touches[0]?.clientX ?? 0
                  }}
                  onTouchMove={(event) => {
                    const dx = (event.touches[0]?.clientX ?? 0) - swipeStartX.current
                    if (dx < -34) setSwipedId(order.id)
                    else if (dx > 34) setSwipedId(null)
                  }}
                  onClickCapture={(event) => {
                    if (swipedId === order.id) {
                      event.preventDefault()
                      event.stopPropagation()
                      setSwipedId(null)
                    }
                  }}
                >
                  <td className="col-wide">{order.order_no}</td>
                  <td className="col-third">{order.customer}</td>
                  <td className="col-third">{order.order_date}</td>
                  <td><span className="tag tag-status tag-status-out">已出库</span></td>
                  <td className="col-third">{order.warehouse || '—'}</td>
                  <td className="col-third">{order.operator || '—'}</td>
                  <td className="num col-third">{formatCubic(order.total_cubic)}</td>
                  {money && (
                    <td className="num amount col-third">
                      {formatAmount(order.total_amount)}
                    </td>
                  )}
                  <td className="num">{order.item_count}</td>
                  <td>
                    <div className="swipe-actions">
                      <button
                        type="button"
                        className="swipe-btn"
                        onClick={() => void openEdit({ id: order.id, order_no: order.order_no })}
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
                        撤销出库
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
                            onClick={() =>
                              void openEdit({ id: order.id, order_no: order.order_no })
                            }
                          >
                            编辑
                          </button>
                          <button
                            className="btn btn-sm btn-danger"
                            title="撤销这张出库单：库存会回退，单据进回收站（可恢复）"
                            onClick={() =>
                              setDeleteTarget({
                                id: order.id,
                                order_no: order.order_no,
                              })
                            }
                          >
                            撤销出库
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
              text="暂无出库单"
              hint="出库从在库的码单里挑，挑完库存自动扣减"
              action={{ label: '新增出库', to: '/outbound/new' }}
            />
          )}
        {listLoading && <TableSkeleton rows={6} cols={5} />}
          <Pager
            total={total}
            limit={PAGE_SIZE}
            offset={offset}
            onChange={setOffset}
            unit="张出库单"
          />
        </div>
        </>
      ) : (
        <div className="card sheet">
          {/* 表头一行：客户 / 出库日期 / 单号，右侧保存 */}
          <div className="sheet-top">
            <label className="sheet-field">
              <span>
                客户<b className="req">*</b>
              </span>
              <input
                className="input"
                list="customer-options"
                value={form.customer}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, customer: event.target.value }))
                }
              />
            </label>
            <label className="sheet-field">
              <span>出库日期</span>
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
            {/* 桌面端留在这里；手机端改用卡片外那份（见 .sheet-actions-fixed） */}
            <div className="sheet-actions sheet-actions-inline">
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
              {/* 连着录几张出库单时不用回列表 */}
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
              <button
                className="btn"
                onClick={backToList}
              >
                取消
              </button>
            </div>
          </div>

          <datalist id="customer-options">
            {customerOptions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>

          <div className="sheet-toolbar">
            <button className="btn btn-sm" onClick={() => openPicker('multi')}>
              选择码单
            </button>
            <button className="btn btn-sm" onClick={() => { setScanHint(''); setScannerOpen(true) }}>
              扫一扫
            </button>
            <button className="btn btn-sm" onClick={() => openPicker('one')}>
              + 新增（手动选一包）
            </button>
            <button
              className="btn btn-sm btn-danger"
              onClick={removePickedRows}
              disabled={pickedRows.length === 0}
            >
              删除选中（{pickedRows.length}）
            </button>
            <span className="spacer" />
            <span className="muted">
              一包一单：点「选择码单」可多选、点「+ 新增」追加一行；规格和立方由码单带出
              {editing ? '；修改时会重新校验码单是否还在库' : ''}
            </span>
          </div>

          {/*
            常用规格：出库的规格是从码单带出来的（不能手填），所以这里的用法是
            **点一下打开选码单、只看这个规格的包** —— 仓管常整批出同一个规格。
          */}
          {recentSpecs.length > 0 && (
            <div className="spec-chips">
              <span className="spec-chips-label">常用规格</span>
              {recentSpecs.map((one) => (
                <button
                  key={`${one.species}-${one.thickness}-${one.width}-${one.length}`}
                  type="button"
                  className="spec-chip"
                  title={`只看 ${one.species} ${one.grade || '（无等级）'} ${one.thickness}×${one.width}×${one.length} 的在库码单`}
                  onClick={() => {
                    tapFeedback()
                    setSpecFilter(one)
                    openPicker('multi')
                  }}
                >
                  {one.thickness}×{one.width}×{one.length}
                  <em>{one.species}</em>
                </button>
              ))}
            </div>
          )}

          <div className="sheet-scroll">
            <table className="sheet-table sheet-outbound">
              <thead>
                <tr>
                  <th className="col-no">#</th>
                  {/* 操作列放最左边（# 后面）：和入库 / 改包两张明细表位置一致 */}
                  <th className="col-op">操作</th>
                  <th className="col-check">
                    <input
                      type="checkbox"
                      checked={computedRows.length > 0 && pickedRows.length === computedRows.length}
                      onChange={(event) =>
                        setPickedRows(
                          event.target.checked ? computedRows.map((row) => row.key) : [],
                        )
                      }
                    />
                  </th>
                  <th className="col-code">条码号</th>
                  <th>包号</th>
                  {specFields.map(({ field, label }) => (
                    <th
                      key={field}
                      className={field === 'species' ? 'col-name' : undefined}
                    >
                      {label}
                    </th>
                  ))}
                  {numberFields.slice(0, 2).map(({ field, label }) => (
                    <th key={field}>{label}</th>
                  ))}
                  <th className="col-unit">数量 (m³)</th>
                  <th className="col-unit">单位</th>
                  {numberFields.slice(2).map(({ field }) => (
                    <th key={field}>{field === 'unitPrice' ? '单价 (元) *' : field}</th>
                  ))}
                  {money && <th>金额 (元)</th>}
                  <th className="col-stock">当前库存 (m³ / 件)</th>
                </tr>
              </thead>
              <tbody>
              {computedRows.map((row, index) => {
                const stock = row.specKey ? stockMap[row.specKey] : undefined
                const short = stock ? row.cubic > stock.cubic + EPSILON : false
                const reasons = rowErrors[row.key] ?? []
                return (
                  <Fragment key={row.key}>
                    <tr
                      data-row-key={row.key}
                      className={[
                        reasons.length > 0 ? 'is-error' : '',
                        short ? 'is-short' : '',
                        expandedRows.includes(row.key) ? 'is-expanded' : '',
                      ]
                        .filter(Boolean)
                        .join(' ') || undefined}
                    >
                      <td className="col-no">{index + 1}</td>
                      <td className="col-op">
                        {/*
                          出库明细都是「选择码单」带进来的，行内不需要加行 / 复制
                          （要加行点工具栏的「选择码单」「新增一行」），所以这里只留删行。
                        */}
                        <span title={rows.length <= 1 ? '至少要保留一行' : '删掉这一行'}>
                          <button
                            type="button"
                            className="sheet-act sheet-act-danger"
                            disabled={rows.length <= 1}
                            onClick={() => removeRow(row.key)}
                          >
                            ✕ 删行
                          </button>
                        </span>
                        {/* 手机端：展开/收起次要字段（桌面端不显示，18 列都在表里） */}
                        <button
                          type="button"
                          className="sheet-act sheet-act-more"
                          onClick={() =>
                            setExpandedRows((prev) =>
                              prev.includes(row.key)
                                ? prev.filter((item) => item !== row.key)
                                : [...prev, row.key],
                            )
                          }
                        >
                          {expandedRows.includes(row.key) ? '收起' : '更多'}
                        </button>
                      </td>
                      <td className="col-check">
                        <input
                          type="checkbox"
                          disabled={!row.baleId}
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
                      <td className="col-code col-more" data-label="条码号">
                        {row.baleBarcode || '—'}
                      </td>
                      {/* 选了包但没填包号 → 显示「—」；一行都没选才是「未选码单」 */}
                      <td className="col-lead" data-label="包号">
                        {row.baleId ? row.baleNo || '—' : '未选码单'}
                      </td>
                      {specFields.map(({ field }) => (
                        <td
                          key={field}
                          /*
                           * 手机端两行版：包号 + 厚 / 宽 / 长 一行（.col-tiny），
                           * 品名 + 片数 + 单价 一行（.col-name-row / .col-qty / .col-price）。
                           */
                          className={
                            field === 'species'
                              ? 'col-name-row'
                              : field === 'grade'
                                ? 'col-more'
                                : 'col-tiny'
                          }
                          data-label={
                            field === 'thickness'
                              ? '厚'
                              : field === 'width'
                                ? '宽'
                                : field === 'length'
                                  ? '长'
                                  : undefined
                          }
                        >
                          <input
                            className="sheet-input input-locked"
                            type="text"
                            enterKeyHint="next"
                            readOnly
                            placeholder="未选"
                            value={row[field]}
                          />
                        </td>
                      ))}
                      {numberFields.slice(0, 2).map(({ field }) => (
                        <td
                          key={field}
                          className={field === 'pieces' ? 'col-qty' : 'col-more'}
                          data-label={field === 'pieces' ? '片数' : '件数'}
                        >
                          <input
                            className="sheet-input"
                            type="text"
                            /* 字段名显示在输入框上方，这里不放占位符（示例值会被当成已填数据） */
                            /* 片数 / 件数只要整数 */
                            inputMode="numeric"
                            enterKeyHint="next"
                            onKeyDown={enterToNext}
                            value={row[field]}
                            onChange={(event) =>
                              updateRow(row.key, field, event.target.value)
                            }
                          />
                        </td>
                      ))}
                      <td className="col-unit num col-more" data-label="数量 (m³)">
                        {formatCubic(row.cubic)}
                      </td>
                      <td className="col-unit col-more" data-label="单位">
                        m³
                      </td>
                      {numberFields.slice(2).map(({ field }) => (
                        <td key={field} className="col-price" data-label="单价">
                          <input
                            className="sheet-input"
                            type="text"
                            inputMode="decimal"
                            /* 字段名在上面，不放占位符 */
                            enterKeyHint="done"
                            onKeyDown={enterToNext}
                            value={row[field]}
                            onChange={(event) =>
                              updateRow(row.key, field, event.target.value)
                            }
                          />
                        </td>
                      ))}
                      {money && (
                        <td className="num col-more" data-label="金额 (元)">
                          {formatAmount(row.amount)}
                        </td>
                      )}
                      {/*
                        当前库存：出库时该看的那一格。
                        手机上整行压成两行，放不下这一格了 → 收进「更多」；
                        库存不够时整行会标红（tr.is-short），提示不会丢。
                      */}
                      <td
                        className={
                          short
                            ? 'col-stock num col-more is-short'
                            : 'col-stock num col-more'
                        }
                        data-label="库存"
                      >
                        {stock ? `${formatCubic(stock.cubic)} 立方 / ${stock.bundles} 件` : '—'}
                        {short ? ' 不足' : ''}
                      </td>
                    </tr>
                    {reasons.length > 0 && (
                      <tr className="is-error">
                        <td colSpan={sheetColumns} className="row-error">
                          {reasons.join('；')}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
              <tfoot>
                <tr>
                  <td colSpan={10} className="sheet-total-label">
                    合计
                  </td>
                  <td className="num">{totals.pieces || ''}</td>
                  <td className="num">{totals.bundles || ''}</td>
                  <td className="num">{formatCubic(totals.cubic)}</td>
                  <td>m³</td>
                  {/* 单价列始终占位；金额列只有看得到金额的角色才有 */}
                  <td />
                  {money && <td className="num">{formatAmount(totals.amount)}</td>}
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>

          <textarea
            className="input textarea sheet-note"
            placeholder="备注（选填）"
            value={form.remark}
            onChange={(event) => setForm((prev) => ({ ...prev, remark: event.target.value }))}
          />

          <div className="sheet-bottom">
            <label className="sheet-field">
              <span>
                仓库<b className="req">*</b>
              </span>
              <input
                className="input"
                placeholder="例如：一号仓"
                value={form.warehouse}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, warehouse: event.target.value }))
                }
              />
            </label>
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
            <label className="sheet-field">
              <span>车号</span>
              <input
                className="input"
                placeholder="选填，例如：鲁Q12345"
                value={form.vehicleNo}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, vehicleNo: event.target.value }))
                }
              />
            </label>
          </div>

          <p className="hint">
            {editing
              ? `正在修改出库单 ${editing.order_no}：单号不变，保存时会重新校验库存。`
              : '单号保存时自动生成（CK + 日期 + 流水）。'}
            单价必填；立方按规格和数量实时算。
          </p>
        </div>
      )}

      {/* 手机端操作栏：放在卡片外面（iOS 上卡片内的 fixed 会被裁剪容器抓走，见 index.css） */}
      {mode === 'create' && (
        <div className="sheet-actions sheet-actions-fixed">
          {!online && <span className="action-offline-hint">请检查网络</span>}
          <button
            className="btn btn-primary"
            onClick={() => {
              tapMedium()
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
              tapMedium()
              void handleSave(true)
            }}
            disabled={saving}
          >
            保存并继续
          </button>
          <button
            className="btn"
            onClick={backToList}
          >
            取消
          </button>
        </div>
      )}

      {(detail || detailLoading || detailError) && (
        <div className="overlay" onClick={closeDetail}>
          <div className="modal modal-xwide" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h2 className="modal-title">
                出库单详情{detail ? `：${detail.order_no}` : ''}
                {detail ? (
                  <span className="tag tag-status tag-detail-status tag-status-out">已出库</span>
                ) : null}
              </h2>
              <div className="modal-actions">
                {detail && (
                  <>
                    {canWrite && (
                      <>
                        <button
                          className="btn btn-sm"
                          onClick={() =>
                            void openEdit({ id: detail.id, order_no: detail.order_no })
                          }
                        >
                          编辑
                        </button>
                        <button
                          className="btn btn-sm btn-danger"
                          title="撤销这张出库单：库存会回退，单据进回收站（可恢复）"
                          onClick={() =>
                            setDeleteTarget({
                              id: detail.id,
                              order_no: detail.order_no,
                            })
                          }
                        >
                          撤销出库
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
                  <span>单号：{detail.order_no}</span>
                  <span>客户：{detail.customer || '—'}</span>
                  <span>日期：{detail.order_date || '—'}</span>
                  <span>仓库：{detail.warehouse || '—'}</span>
                  <span>操作员：{detail.operator || '—'}</span>
                  <span>车号：{detail.vehicle_no || '—'}</span>
                  <span>备注：{detail.remark || '—'}</span>
                  <span>创建时间：{detail.created_at}</span>
                  <span>明细行数：{detail.items.length}</span>
                  <span>码单数：{detail.bales.length} 包</span>
                  <span>总立方：{formatCubic(detail.total_cubic)} m³</span>
                  {money && <span>总金额：{formatAmount(detail.total_amount)} 元</span>}
                </div>

                <table className="table">
                  <thead>
                    <tr>
                      <th>包号</th>
                      <th>品牌</th>
                      <th>品名</th>
                      <th>等级</th>
                      <th className="num">厚度mm</th>
                      <th className="num">宽度mm</th>
                      <th className="num">长度m</th>
                      <th className="num">片数</th>
                      <th className="num">件数</th>
                      <th className="num">立方</th>
                      <th className="num">当前库存</th>
                      {money && <th className="num">单价</th>}
                      {money && <th className="num">金额</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {detail.items.map((item) => (
                      <tr key={item.id}>
                        <td>
                          {item.bale_no ||
                            (Array.isArray(item.bale_labels) ? item.bale_labels.join('、') : '') ||
                            '—'}
                        </td>
                        <td>{item.brand || '—'}</td>
                        <td>{item.species}</td>
                        <td>{item.grade}</td>
                        <td className="num">{item.thickness}</td>
                        <td className="num">{item.width}</td>
                        <td className="num">{item.length}</td>
                        <td className="num">{item.pieces}</td>
                        <td className="num">{item.bundles}</td>
                        <td className="num">{formatCubic(item.cubic)}</td>
                        <td className="num">
                          {formatCubic(item.stock_cubic ?? 0)} 立方 /{' '}
                          {item.stock_bundles ?? 0} 件
                        </td>
                        {money && (
                          <td className="num amount">{formatAmount(item.unit_price)}</td>
                        )}
                        {money && (
                          <td className="num amount">{formatAmount(item.amount)}</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div className="totals">
                  <span>合计立方：{formatCubic(detail.total_cubic)}</span>
                  {money && (
                    <span>合计金额：{formatAmount(detail.total_amount)}</span>
                  )}
                </div>

                {detail.bales && detail.bales.length > 0 && (
                  <>
                    <h3 className="section-title" style={{ marginTop: 22 }}>
                      本次发出的码单（{detail.bales.length} 包）
                    </h3>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>包号</th>
                          <th>条码号</th>
                          <th>提单号</th>
                          <th>合同号</th>
                          <th>状态</th>
                          {/* 和别处一个口径：厚 / 宽 单值，长度 / 片数混装时写斜杠串 */}
                          <th className="num">厚度 (mm)</th>
                          <th className="num">宽度 (mm)</th>
                          <th className="num">长度 (m)</th>
                          <th className="num">片数</th>
                          <th className="num">立方</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.bales.map((bale) => (
                          <tr key={bale.barcode || bale.bale_no}>
                            <td>{bale.bale_no || '—'}</td>
                            <td>{bale.barcode || '—'}</td>
                            <td>{bale.bl_no || '—'}</td>
                            <td>{bale.contract_no || '—'}</td>
                            <td>
                              <span
                                className={
                                  bale.status === 'shipped'
                                    ? 'tag tag-status tag-status-out'
                                    : 'tag tag-status tag-status-in'
                                }
                              >
                                {bale.status === 'shipped' ? '已出库' : '在库'}
                              </span>
                            </td>
                            <td className="num">{bale.thickness}</td>
                            <td className="num">{bale.width}</td>
                            <td className="num">{bale.length_text ?? bale.length}</td>
                            <td className="num">{bale.pieces_text ?? bale.pieces}</td>
                            <td className="num">{formatCubic(bale.cubic)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {pickerRowKey !== null && (
        <div className="overlay" onClick={() => setPickerRowKey(null)}>
          <div
            className="modal modal-wide"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <h2 className="modal-title">
                {pickerIntent === 'one' ? '新增一行：选一包' : '选择码单'}
              </h2>
              <button
                className="btn btn-sm btn-quiet"
                onClick={() => setPickerRowKey(null)}
              >
                关闭
              </button>
            </div>

            <div className="toolbar">
              <input
                className="input input-wide"
                placeholder="包号 / 条码号 / 提单号 / 合同号 / 品名"
                title="包号 / 条码号 / 提单号 / 合同号 / 品名"
                value={pickerKeyword}
                onChange={(event) => setPickerKeyword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    void loadPickerRows(pickerKeyword.trim())
                  }
                }}
              />
              <button
                className="btn"
                onClick={() => void loadPickerRows(pickerKeyword.trim())}
              >
                查询
              </button>
              {/* 从「常用规格」点进来时：只看这个规格的包，随时能清掉 */}
              {specFilter && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setSpecFilter(null)}
                  title="取消规格筛选，显示全部在库码单"
                >
                  只看 {specFilter.thickness}×{specFilter.width}×{specFilter.length} ✕
                </button>
              )}
              <span className="spacer" />
              <span className="muted">
                {pickerIntent === 'one'
                  ? '只列在库的码单，点某一行的「选择」就追加到明细末尾'
                  : '只列在库的码单，勾选后确认（会追加到明细，不会冲掉已有的行）'}
              </span>
              {pickerIntent === 'multi' && (
                <button
                  className="btn btn-primary"
                  onClick={() => void applyBales()}
                  disabled={pickerApplying}
                >
                  {pickerApplying ? '读取成本价…' : `确认选择（${pickedBaleIds.length}）`}
                </button>
              )}
            </div>

            <table className="table">
              <thead>
                <tr>
                  <th>选择</th>
                  <th>包号</th>
                  <th>条码号</th>
                  <th>提单号</th>
                  <th>合同号</th>
                  <th>品名</th>
                  <th>等级</th>
                  <th className="num">厚度</th>
                  <th className="num">宽度</th>
                  <th className="num">长度</th>
                  <th className="num">片数</th>
                  <th className="num">立方</th>
                </tr>
              </thead>
              <tbody>
                {(specFilter
                  ? pickerBales.filter(
                      (row) =>
                        String(row.thickness) === specFilter.thickness &&
                        String(row.width) === specFilter.width &&
                        String(row.length_text ?? row.length).startsWith(specFilter.length),
                    )
                  : pickerBales
                ).map((row) => (
                  <tr key={row.id}>
                    <td>
                      {pickerIntent === 'one' ? (
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={pickerApplying || rowBaleIds().has(row.id)}
                          onClick={() => void appendBales([row])}
                        >
                          {rowBaleIds().has(row.id) ? '已在明细' : '选择'}
                        </button>
                      ) : (
                        <input
                          type="checkbox"
                          checked={pickedBaleIds.includes(row.id)}
                          onChange={(event) =>
                            setPickedBaleIds((prev) =>
                              event.target.checked
                                ? [...prev, row.id]
                                : prev.filter((id) => id !== row.id),
                            )
                          }
                        />
                      )}
                    </td>
                    <td>{row.bale_no || '—'}</td>
                    <td>{row.barcode || '—'}</td>
                    <td>{row.bl_no || '—'}</td>
                    <td>{row.contract_no || '—'}</td>
                    <td>{row.species}</td>
                    <td>{row.grade || '—'}</td>
                    {/* 厚度 / 宽度永远单值；长度和片数是混装包才用斜杠串（1.8/2.1/2.4、17/30/247） */}
                    <td className="num">{row.thickness}</td>
                    <td className="num">{row.width}</td>
                    <td className="num">{row.length_text ?? row.length}</td>
                    <td className="num">{row.pieces_text ?? row.pieces}</td>
                    <td className="num">{formatCubic(row.cubic)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {!pickerLoading && pickerBales.length === 0 && (
              <EmptyState text="当前没有在库的码单，请先入库" />
            )}
            {pickerLoading && <Loading />}
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="overlay" onClick={() => setDeleteTarget(null)}>
          <div
            className="modal modal-narrow modal-alert"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="modal-title">撤销出库</h2>
            <p className="confirm-text">
              确认撤销这张出库单？（{deleteTarget.order_no}）
              <br />
              库存会回退到出库前；单据进回收站，之后还能恢复。
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
                onClick={() => {
                  tapHeavy()
                  void confirmDelete()
                }}
                disabled={deleting}
              >
                {deleting ? '撤销中…' : '确认撤销'}
              </button>
            </div>
          </div>
        </div>
      )}

      {scannerOpen && (
        <Suspense fallback={null}>
          <Scanner
            open={scannerOpen}
            onClose={() => setScannerOpen(false)}
            onScan={handleScan}
          />
        </Suspense>
      )}
    </section>
  )
}
