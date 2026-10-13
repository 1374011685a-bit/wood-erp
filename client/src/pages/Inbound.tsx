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
  openContractFile,
  fetchStockList,
  inboundExportUrl,
  updateInbound,
  type ContractOption,
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

/* ---------- 立方预览：与 server/utils/cubic.js 同一公式 ---------- */

const CUBIC_DIVISOR = 1000000

const toNumber = (value: string) => {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

const roundTo = (value: number, digits: number) => Number(value.toFixed(digits))

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

// 立方去掉无意义的末尾零（13.68），金额固定两位（28728.00）
const formatCubic = (value: number) => String(roundTo(value, 4))
const formatAmount = (value: number) => value.toFixed(2)

const todayISO = () => {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

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
  if (toNumber(row.unitPrice) < 0) reasons.push('单价不能为负数')

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

const emptyFilters: InboundListFilters = {}

const emptyInput = {
  order_no: '',
  supplier: '',
  warehouse: '',
  operator: '',
  date_from: '',
  date_to: '',
}

const PAGE_SIZE = 20

/* ---------- 样式 ---------- */


const rowFields: { field: keyof Omit<FormRow, 'key'>; label: string }[] = [
  { field: 'species', label: '品名' },
  { field: 'grade', label: '等级' },
  { field: 'thickness', label: '厚度mm' },
  { field: 'width', label: '宽度mm' },
  { field: 'length', label: '长度m' },
  { field: 'pieces', label: '片数' },
  { field: 'bundles', label: '件数' },
  { field: 'unitPrice', label: '单价' },
]

export default function Inbound() {
  const [mode, setMode] = useState<'list' | 'create'>('list')
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
    contractNo: '',
  })
  const [rows, setRows] = useState<FormRow[]>(() => [createRow()])
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
    fetchContractOptions()
      .then((options) => {
        if (!cancelled) setContractOptions(options)
      })
      .catch(() => {
        // 拉不到就退化成手填，不打扰用户
      })
    return () => {
      cancelled = true
    }
  }, [mode, editing])

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
        }),
        { cubic: 0, amount: 0 },
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

  const addRow = () => {
    setRows((prev) => [...prev, createRow()])
    if (formError) setFormError('')
  }

  const removeRow = (key: number) => {
    setRows((prev) => (prev.length > 1 ? prev.filter((row) => row.key !== key) : prev))
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
    setForm({
      supplier: '',
      orderDate: todayISO(),
      remark: '',
      warehouse: '',
      operator: '',
      blNo: '',
      contractNo: '',
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
      const data = await fetchInboundDetail(item.id)
      setForm({
        supplier: data.supplier ?? '',
        orderDate: data.order_date ?? todayISO(),
        remark: data.remark ?? '',
        warehouse: data.warehouse ?? '',
        operator: data.operator ?? '',
        blNo: data.bl_no ?? '',
        contractNo: data.contract_no ?? '',
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
        contract_no: form.contractNo.trim(),
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
        contractNo: '',
      })
      setRows([createRow()])
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
        title="入库"
        subtitle="录入与修改入库单、按供应商与日期查询、查看明细；保存时自动生成单号并重算立方金额"
        extra={
          <button className="btn" onClick={handleExport} disabled={exporting}>
            {exporting ? '导出中…' : '导出 Excel'}
          </button>
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

      {mode === 'list' ? (
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
            <button className="btn btn-primary" onClick={openCreate}>
              新增入库
            </button>
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
            <EmptyState text="暂无入库单，点右上角「新增入库」录入" />
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
        <div className="card">
          <div className="field-row">
            <label className="field field-required">
              <span>供应商</span>
              <input
                className="input"
                value={form.supplier}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, supplier: event.target.value }))
                }
              />
            </label>
            <label className="field">
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
          </div>

          {/* 第二行：操作员 + 仓库（仓库必填） */}
          <div className="field-row">
            <label className="field">
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
            <label className="field field-required">
              <span>仓库</span>
              <input
                className="input"
                placeholder="例如：一号仓"
                value={form.warehouse}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, warehouse: event.target.value }))
                }
              />
            </label>
          </div>

          {/* 第三行：提单号 + 合同号（合同号可以从已上传的合同里选） */}
          <div className="field-row">
            <label className="field">
              <span>提单号</span>
              <input
                className="input"
                placeholder="例如：BL-2026-0001"
                value={form.blNo}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, blNo: event.target.value }))
                }
              />
            </label>
            <label className="field">
              <span>合同号</span>
              <input
                className="input"
                list="contract-options"
                placeholder="可从已有合同里选，也可手填"
                value={form.contractNo}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, contractNo: event.target.value }))
                }
              />
            </label>
            <datalist id="contract-options">
              {contractOptions.map((option) => (
                <option key={option.id} value={option.contract_no}>
                  {[option.title, option.partner].filter(Boolean).join(' · ')}
                </option>
              ))}
            </datalist>
          </div>

          <table className="table table-detail">
            <thead>
              <tr>
                {rowFields.map(({ field, label }) => (
                  <th key={field}>
                    {label}
                  </th>
                ))}
                <th className="num">立方</th>
                <th className="num">金额</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {computedRows.map((row) => {
                const reasons = rowErrors[row.key] ?? []
                const hint = row.specKey ? stockLookup[row.specKey] : undefined
                return (
                  <Fragment key={row.key}>
                    <tr>
                      {rowFields.map(({ field }) => (
                        <td key={field} data-label={rowFields.find((f) => f.field === field)?.label}>
                          <input
                            className={
                              reasons.length > 0
                                ? 'input input-cell input-error'
                                : 'input input-cell'
                            }
                            type="text"
                            inputMode={
                              field === 'species' || field === 'grade'
                                ? undefined
                                : 'decimal'
                            }
                            value={row[field]}
                            onChange={(event) =>
                              updateRow(row.key, field, event.target.value)
                            }
                          />
                        </td>
                      ))}
                      <td className="num" data-label="立方">
                        {formatCubic(row.cubic)}
                      </td>
                      <td className="num amount" data-label="金额">
                        {formatAmount(row.amount)}
                      </td>
                      <td className="cell-actions">
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() => removeRow(row.key)}
                          disabled={rows.length === 1}
                        >
                          删一行
                        </button>
                      </td>
                    </tr>
                    {hint && (
                      <tr>
                        <td colSpan={11} className="row-hint">
                          该规格已有库存 {formatCubic(hint.cubic)} 立方 / {hint.bundles} 件
                        </td>
                      </tr>
                    )}
                    {reasons.length > 0 && (
                      <tr>
                        <td colSpan={11} className="row-error">
                          {reasons.join('；')}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>

          <div className="row-tools">
            <button className="btn" onClick={addRow}>
              + 加一行
            </button>
          </div>

          <div className="totals">
            <span>合计立方：{formatCubic(totals.cubic)}</span>
            <span>合计金额：{formatAmount(totals.amount)}</span>
          </div>

          <div className="row-tools">
            <button
              className="btn btn-primary"
              onClick={() => void handleSave()}
              disabled={saving}
            >
              {saving ? '提交中…' : editing ? '确认修改' : '确认'}
            </button>
            <button
              className="btn"
              onClick={() => {
                setMode('list')
                setEditing(null)
              }}
            >
              取消
            </button>
            <span className="muted">
              {editing
                ? `正在修改入库单 ${editing.order_no}，单号不变，库存会按差异自动调整`
                : '单号保存时自动生成（RK + 日期 + 流水）'}
            </span>
          </div>
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

                <div className="totals">
                  <span>合计立方：{formatCubic(detail.total_cubic)}</span>
                  <span>合计金额：{formatAmount(detail.total_amount)}</span>
                </div>
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
    </section>
  )
}
