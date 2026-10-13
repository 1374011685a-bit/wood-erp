import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useEscapeKey } from '../hooks/useEscapeKey'
import {
  createInbound,
  deleteInbound,
  downloadFile,
  fetchInboundDetail,
  fetchInboundList,
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
  type InboundItemPayload,
  type InboundListFilters,
  type InboundListItem,
} from '../api'
import {
  EmptyState,
  Loading,
  PageHead,
  Pager,
  ToastHost,
} from '../components/Ui'
import { toNumber, roundTo, formatCubic, formatAmount, todayISO } from '../utils/num'

/* ---------- 立方预览：与 server/utils/cubic.js 同一公式 ---------- */

const CUBIC_DIVISOR = 1000000

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
  /** 箱号：这包货装在哪个箱/柜里 */
  boxNo: string
  /** 包号（=码单号）：留空由系统自动编号；混装包时手动填同一个号 */
  baleLabel: string
  /** 「同包再加一行」：这一行是往上一行那个包里再加一个规格 */
  samePackage?: boolean
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
  while (next.length < MIN_SHEET_ROWS) next.push(createRow())
  return next
}

const isRowEmpty = (row: FormRow) =>
  !row.baleLabel.trim() &&
  !row.boxNo.trim() &&
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

/* ---------- 样式 ---------- */


/** 表里能输入的列（samePackage 只是标记，不是输入框） */
type RowField =
  | 'baleLabel'
  | 'boxNo'
  | 'species'
  | 'grade'
  | 'thickness'
  | 'width'
  | 'length'
  | 'pieces'
  | 'bundles'

const rowFields: { field: RowField; label: string }[] = [
  { field: 'baleLabel', label: '包号' },
  { field: 'boxNo', label: '箱号' },
  { field: 'species', label: '品名 *' },
  { field: 'grade', label: '等级' },
  { field: 'thickness', label: '厚度 (mm)' },
  { field: 'width', label: '宽度 (mm)' },
  { field: 'length', label: '长度 (m)' },
  { field: 'pieces', label: '片数 (片)' },
  { field: 'bundles', label: '件数 (件)' },
]

export default function Inbound({
  defaultMode = 'list',
}: {
  /** /inbound 走「先选入库方式」，/inbound/records 直接看记录 */
  defaultMode?: 'method' | 'list'
}) {
  const [mode, setMode] = useState<'method' | 'list' | 'create'>(defaultMode)
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

  const [list, setList] = useState<InboundListItem[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState('')
  const [notice, setNotice] = useState('')

  const [input, setInput] = useState(emptyInput)
  const [filters, setFilters] = useState<InboundListFilters>(emptyFilters)
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

  // 选了提单：合同号、提单号从提单上带出来，不用在这张单上重复填
  const handlePickShipment = (id: number) => {
    setShipmentId(id)
    const box = shipmentOptions.find((item) => item.id === id)
    if (!box) return
    setForm((prev) => ({
      ...prev,
      contractNo: box.contract_no ?? '',
      blNo: box.bl_no ?? '',
    }))
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
      if (row.samePackage) continue

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

  /** 柜数：明细里填了几个不同的箱号，系统自己数 */
  const boxCount = useMemo(() => {
    const boxes = new Set<string>()
    for (const row of computedRows) {
      if (isRowEmpty(row)) continue
      const box = row.boxNo.trim()
      if (box) boxes.add(box)
    }
    return boxes.size
  }, [computedRows])

  /**
   * 包号失焦就查一次重：范围是「这张提单内」（散货新单没有单据号，无可查）。
   * 命中就当场标红，不用等到保存。
   */
  const checkRowBaleNo = async (key: number) => {
    const row = rows.find((item) => item.key === key)
    const label = row?.baleLabel.trim() ?? ''
    if (!row || !label || row.samePackage || !shipmentId) return

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

  /** 在指定行下面插一行 */
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
   * 「同包再加一行」：在下面插一行，自动继承这一行的包号，
   * 并标记为同包（后端就知道这是往同一个包里加规格，而不是新开一包）。
   */
  const addSamePackageRow = (key: number) => {
    setRows((prev) => {
      const index = prev.findIndex((row) => row.key === key)
      if (index < 0) return prev
      const label = prev[index].baleLabel.trim()
      if (!label) return prev
      const next = [...prev]
      next.splice(index + 1, 0, {
        ...createRow(),
        boxNo: prev[index].boxNo,
        baleLabel: label,
        samePackage: true,
      })
      return next
    })
    if (formError) setFormError('')
  }

  const removeRow = (key: number) => {
    setRows((prev) => padRows(prev.filter((row) => row.key !== key)))
    setPickedRows((prev) => prev.filter((item) => item !== key))
    if (formError) setFormError('')
  }

  /** 删掉勾选的行 */
  const removePickedRows = () => {
    if (pickedRows.length === 0) return
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
    setRowErrors({})
    setHasValidated(false)
    // 先走「请选择入库方式」，和千木云一致
    setMethod('direct')
    setPickedContract(null)
    setMode('method')
  }

  // 修改：拉出原单明细填进同一套表单，保存时走 PUT，单号保持不变
  const openEdit = async (item: { id: number; order_no: string }) => {
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
          // 编辑老单据时包号留空，改完保存会按老单据原有码单处理
          baleLabel: '',
          boxNo: line.box_no ?? '',
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
      setNotice('已删除')
      setReloadToken((n) => n + 1)
    } catch (err) {
      // 后端返回的原因（比如删了会超卖）原样展示
      setDeleteTarget(null)
      setActionError(err instanceof Error ? err.message : '删除失败')
    } finally {
      setDeleting(false)
    }
  }

  const handleSave = async () => {
    const supplier = form.supplier.trim()

    setHasValidated(true)
    const errors = validateRows(rows)
    setRowErrors(errors)
    setFormError('')

    if (!supplier) {
      setFormError('供应商不能为空')
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
      // 包号：填了范围就按范围生成码单，留空让后端自动编号
      bale_labels: parseBaleLabels(row.baleLabel),
      box_no: row.boxNo.trim(),
      same_package: row.samePackage === true,
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
      }
      const result = editing
        ? await updateInbound(editing.id, payload)
        : await createInbound(payload)
      // 回到列表：清空筛选后重新加载，保证新单一定可见
      setMode('list')
      setEditing(null)
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
              <button className="btn btn-primary" onClick={openCreate}>
                新增采购
              </button>
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
          <div className="toolbar">
            <input
              className="input"
              placeholder="单号关键字"
              value={input.order_no}
              onChange={(event) =>
                setInput((prev) => ({ ...prev, order_no: event.target.value }))
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleSearch()
              }}
            />
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
            <button className="btn" onClick={handleSearch}>
              查询
            </button>
            <button className="btn" onClick={handleResetFilters}>
              重置
            </button>
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
                <th className="num">总金额</th>
                <th className="num">明细数</th>
                <th className="num">码单</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((order) => (
                <tr key={order.id}>
                  <td>{order.order_no}</td>
                  <td>{order.supplier}</td>
                  <td>{order.order_date}</td>
                  <td>{order.warehouse || '—'}</td>
                  <td>
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
                  <td className="num">{formatCubic(order.total_cubic)}</td>
                  <td className="num amount">
                    {formatAmount(order.total_amount)}
                  </td>
                  <td className="num">{order.item_count}</td>
                  <td className="num">
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
                  <td>
                    <div className="row-actions">
                      <button
                        className="btn btn-sm"
                        onClick={() => void openDetail(order.id)}
                      >
                        查看
                      </button>
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
                        onClick={() =>
                          setDeleteTarget({
                            id: order.id,
                            order_no: order.order_no,
                          })
                        }
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!listLoading && list.length === 0 && (
            <EmptyState text="暂无入库单，点右上角「新增采购」开始" />
          )}
          {listLoading && <Loading />}
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
          <div className="sheet-top">
            <label className="sheet-field">
              <span>
                供应商<b className="req">*</b>
              </span>
              <input
                className="input"
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
            <button
              className="btn btn-primary"
              onClick={() => void handleSave()}
              disabled={saving}
            >
              {saving ? '保存中…' : '保存'}
            </button>
            <button
              className="btn"
              onClick={() => {
                setMode(defaultMode)
                setEditing(null)
              }}
            >
              取消
            </button>
          </div>

          <div className="sheet-toolbar">
            <button
              className="btn btn-sm btn-danger"
              onClick={removePickedRows}
              disabled={pickedRows.length === 0}
            >
              删除选中（{pickedRows.length}）
            </button>
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
            <table className="sheet-table">
              <thead>
                <tr>
                  <th className="col-no">#</th>
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
                  <th className="col-op">操作</th>
                  {rowFields.map(({ field, label }) => (
                    <th
                      key={field}
                      className={field === 'species' ? 'col-name' : undefined}
                    >
                      {label}
                    </th>
                  ))}
                  <th className="col-unit">数量 (m³)</th>
                  <th className="col-unit">单位</th>
                  <th>单价 (元) *</th>
                  <th>金额 (元)</th>
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
                      <tr className={reasons.length > 0 ? 'is-error' : undefined}>
                        <td className="col-no">{index + 1}</td>
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
                        <td className="col-op">
                          <button
                            type="button"
                            className="sheet-icon"
                            title="在下面插一行"
                            onClick={() => insertRowAfter(row.key)}
                          >
                            +
                          </button>
                          <button
                            type="button"
                            className={
                              row.samePackage ? 'sheet-icon is-on' : 'sheet-icon'
                            }
                            title="同包再加一行：这一包还有别的规格"
                            disabled={!row.baleLabel.trim() || row.samePackage}
                            onClick={() => addSamePackageRow(row.key)}
                          >
                            同
                          </button>
                          <button
                            type="button"
                            className="sheet-icon sheet-icon-danger"
                            title="删掉这一行"
                            onClick={() => removeRow(row.key)}
                          >
                            ✕
                          </button>
                        </td>
                        {rowFields.map(({ field }) => (
                          <td key={field}>
                            {field === 'baleLabel' && row.samePackage ? (
                              // 同包的行包号是继承来的，不让改（改了就不是同一包了）
                              <div className="same-bale-cell">
                                <input className="sheet-input" value={row.baleLabel} readOnly />
                                <span className="same-bale-tag">同包</span>
                              </div>
                            ) : (
                            <input
                              className="sheet-input"
                              type="text"
                              inputMode={
                                field === 'species' || field === 'grade'
                                  ? undefined
                                  : 'decimal'
                              }
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
                            )}
                          </td>
                        ))}
                        <td className="col-unit num">{filler ? '' : formatCubic(row.cubic)}</td>
                        <td className="col-unit">{filler ? '' : 'm³'}</td>
                        <td>
                          <input
                            className="sheet-input num"
                            type="text"
                            inputMode="decimal"
                            value={row.unitPrice}
                            onChange={(event) =>
                              updateRow(row.key, 'unitPrice', event.target.value)
                            }
                          />
                        </td>
                        <td className="num">{filler ? '' : formatAmount(row.amount)}</td>
                        <td className="col-code muted">{filler ? '' : '自动生成'}</td>
                      </tr>
                      {reasons.length > 0 && (
                        <tr className="is-error">
                          <td colSpan={16} className="row-error">
                            {reasons.join('；')}
                          </td>
                        </tr>
                      )}
                      {hint && reasons.length === 0 && (
                        <tr>
                          <td colSpan={16} className="row-hint">
                            该规格已有库存 {formatCubic(hint.cubic)} 立方 / {hint.bundles} 件
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={9} className="sheet-total-label">
                    合计
                  </td>
                  <td className="num">{totals.pieces || ''}</td>
                  <td className="num">{totals.bundles || ''}</td>
                  <td className="num">{formatCubic(totals.cubic)}</td>
                  <td>m³</td>
                  <td />
                  <td className="num">{formatAmount(totals.amount)}</td>
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

          {/* 表下方：提单 / 合同 / 仓库 / 操作员 / 车号 */}
          <div className="sheet-bottom">
            <label className="sheet-field">
              <span>提单（这批到货）</span>
              <select
                className="input"
                value={shipmentId}
                onChange={(event) => handlePickShipment(Number(event.target.value))}
              >
                <option value={0}>不选提单（零散到货）</option>
                {shipmentOptions.map((box) => (
                  <option key={box.id} value={box.id}>
                    {box.bl_no}
                    {box.contract_no ? ` · 合同 ${box.contract_no}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="sheet-field">
              <span>提单号{shipmentId ? '（来自提单）' : ''}</span>
              <input
                className="input"
                placeholder="例如：BL-2026-0001"
                value={form.blNo}
                readOnly={Boolean(shipmentId)}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, blNo: event.target.value }))
                }
              />
            </label>
            <label className="sheet-field">
              <span>
                合同号
                {shipmentId
                  ? '（来自提单）'
                  : method === 'contract' && pickedContract
                    ? '（来自所选采购合同）'
                    : ''}
              </span>
              <input
                className="input"
                list={
                  shipmentId || (method === 'contract' && pickedContract)
                    ? undefined
                    : 'contract-options'
                }
                placeholder="可从已有合同里选，也可手填"
                value={form.contractNo}
                readOnly={Boolean(shipmentId) || (method === 'contract' && !!pickedContract)}
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
            {/* 柜数按明细里的箱号自动统计，不用手填 */}
            <label className="sheet-field">
              <span>柜数（自动统计）</span>
              <input className="input input-readonly" readOnly value={`${boxCount} 个箱`} />
            </label>
          </div>

          <p className="hint">
            包号照货上写的填（可留空）；一包混了几个规格时，把那几行的包号填成同一个号，系统并成一张码单。
            件数就是包数，单价必填。
            {editing ? ' 正在修改老单据：单号不变，库存按差异自动调整。' : ''}
          </p>
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
                      onClick={() =>
                        setDeleteTarget({
                          id: detail.id,
                          order_no: detail.order_no,
                        })
                      }
                    >
                      删除
                    </button>
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
                          <th>品名</th>
                          <th>等级</th>
                          <th className="num">厚×宽×长</th>
                          <th className="num">片数</th>
                          <th className="num">立方</th>
                          <th>状态</th>
                          <th>出库单</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.bales.map((bale) => (
                          <tr key={bale.barcode || bale.bale_no}>
                            <td>{bale.bale_no || '—'}</td>
                            <td>{bale.barcode || '—'}</td>
                            <td>{bale.species}</td>
                            <td>{bale.grade || '—'}</td>
                            <td className="num">
                              {bale.thickness}×{bale.width}×{bale.length}
                            </td>
                            <td className="num">{bale.pieces}</td>
                            <td className="num">{formatCubic(bale.cubic)}</td>
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
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                ) : (
                  <table className="table">
                    <thead>
                      <tr>
                        <th>品名</th>
                        <th>等级</th>
                        <th className="num">厚度mm</th>
                        <th className="num">宽度mm</th>
                        <th className="num">长度m</th>
                        <th className="num">片数</th>
                        <th className="num">件数</th>
                        <th className="num">立方</th>
                        <th className="num">单价</th>
                        <th className="num">金额</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.items.map((item) => (
                        <tr key={item.id}>
                          <td>{item.species}</td>
                          <td>{item.grade}</td>
                          <td className="num">{item.thickness}</td>
                          <td className="num">{item.width}</td>
                          <td className="num">{item.length}</td>
                          <td className="num">{item.pieces}</td>
                          <td className="num">{item.bundles}</td>
                          <td className="num">{formatCubic(item.cubic)}</td>
                          <td className="num amount">{formatAmount(item.unit_price)}</td>
                          <td className="num amount">{formatAmount(item.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

              </>
            )}
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="overlay" onClick={() => setDeleteTarget(null)}>
          <div
            className="modal modal-narrow modal-alert"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="modal-title">删除确认</h2>
            <p className="confirm-text">
              确认删除入库单 {deleteTarget.order_no}？此操作不可恢复。
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
                {deleting ? '删除中…' : '确认删除'}
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
                className="input"
                placeholder="合同号 / 合同名称 / 供应商"
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
                  <th>日期</th>
                  <th>合同号</th>
                  <th>供应商</th>
                  <th>品名</th>
                  <th>品牌</th>
                  <th className="num">合同立方 (m³)</th>
                  <th className="num">已入库 (m³)</th>
                  <th className="num">未到货 (m³)</th>
                  <th className="num">未发货</th>
                  <th>单据状态</th>
                  <th>关联单号</th>
                </tr>
              </thead>
              <tbody>
                {pickerRows.map((row) => (
                  <tr
                    key={row.id}
                    className={pickerPick?.id === row.id ? 'row-active' : undefined}
                    onClick={() => setPickerPick(row)}
                  >
                    <td>
                      <input
                        type="checkbox"
                        checked={pickerPick?.id === row.id}
                        onChange={() => setPickerPick(row)}
                      />
                    </td>
                    <td>{row.sign_date || '—'}</td>
                    <td>{row.contract_no}</td>
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
                                void openEdit({ id: order.id, order_no: order.order_no })
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
