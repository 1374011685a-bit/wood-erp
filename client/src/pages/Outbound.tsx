import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEscapeKey } from '../hooks/useEscapeKey'
import {
  createOutbound,
  deleteOutbound,
  downloadFile,
  fetchOutboundDetail,
  fetchOutboundList,
  fetchStock,
  fetchStockList,
  outboundExportUrl,
  updateOutbound,
  type InboundItemPayload,
  type OutboundDetail,
  type OutboundListFilters,
  type OutboundListItem,
  type StockSnapshot,
  type StockRow,
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
const EPSILON = 1e-9

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

  if (!row.species.trim()) reasons.push('请先点左侧「选择规格」')

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
  { field: 'thickness', label: '厚度mm' },
  { field: 'width', label: '宽度mm' },
  { field: 'length', label: '长度m' },
]

// 需要用户自己填的字段
const numberFields: { field: keyof Omit<FormRow, 'key'>; label: string }[] = [
  { field: 'pieces', label: '片数' },
  { field: 'bundles', label: '件数' },
  { field: 'unitPrice', label: '单价' },
]

const SPEC_ROW_COLUMNS = 1 + specFields.length + numberFields.length + 4 // 选择规格 + 规格 + 数量 + 立方/库存/金额/操作

export default function Outbound() {
  const [mode, setMode] = useState<'list' | 'create'>('list')
  // 非空 = 正在修改这张单（单号不变，只替换明细）
  const [editing, setEditing] = useState<{ id: number; order_no: string } | null>(null)

  const [list, setList] = useState<OutboundListItem[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState('')
  const [notice, setNotice] = useState('')

  const [input, setInput] = useState(emptyInput)
  const [filters, setFilters] = useState<OutboundListFilters>(emptyFilters)
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
  })
  const [rows, setRows] = useState<FormRow[]>(() => [createRow()])
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [rowErrors, setRowErrors] = useState<Record<number, string[]>>({})
  const [hasValidated, setHasValidated] = useState(false)

  // 规格选择弹窗
  const [pickerRowKey, setPickerRowKey] = useState<number | null>(null)
  const [pickerRows, setPickerRows] = useState<StockRow[]>([])
  const [pickerKeyword, setPickerKeyword] = useState('')
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerError, setPickerError] = useState('')
  const pickerKey = pickerRowKey ?? -1

  // 规格 -> 当前库存（实时提示用）
  const [stockMap, setStockMap] = useState<Record<string, StockSnapshot>>({})
  const requestedSpecs = useRef<Set<string>>(new Set())

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
      setListLoading(true)
      setListError('')
      try {
        const result = await fetchOutboundList({
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

  const loadPickerRows = async (keyword: string) => {
    setPickerLoading(true)
    setPickerError('')
    try {
      setPickerRows(await fetchStockList(keyword))
    } catch (err) {
      setPickerError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setPickerLoading(false)
    }
  }

  const openPicker = (rowKey: number) => {
    setPickerRowKey(rowKey)
    setPickerKeyword('')
    setPickerRows([])
    void loadPickerRows('')
  }

  // 选中规格：填好 5 个字段并锁定，片数按最近入库带出，单价按最近入库单价带出
  const applySpec = async (rowKey: number, stockRow: StockRow) => {
    const key = [
      stockRow.species,
      stockRow.grade ?? '',
      stockRow.thickness,
      stockRow.width,
      stockRow.length,
    ].join('|')

    setRows((prev) =>
      prev.map((row) =>
        row.key === rowKey
          ? {
              ...row,
              species: stockRow.species,
              grade: stockRow.grade ?? '',
              thickness: String(stockRow.thickness),
              width: String(stockRow.width),
              length: String(stockRow.length),
              unitPrice:
                stockRow.last_unit_price === null
                  ? row.unitPrice
                  : String(stockRow.last_unit_price),
            }
          : row,
      ),
    )
    setPickerRowKey(null)
    setFormError('')

    try {
      const snapshot = await fetchStock({
        species: stockRow.species,
        grade: stockRow.grade ?? '',
        thickness: stockRow.thickness,
        width: stockRow.width,
        length: stockRow.length,
      })
      requestedSpecs.current.add(key)
      setStockMap((prev) => ({ ...prev, [key]: snapshot }))
      if (snapshot.pieces > 0) {
        setRows((prev) =>
          prev.map((row) =>
            row.key === rowKey ? { ...row, pieces: String(snapshot.pieces) } : row,
          ),
        )
      }
    } catch {
      // 取不到就保持原样，用户可手填片数
    }
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
      setNotice('已删除')
      // 出库单删掉后库存回涨，「当前库存」提示要重新取
      requestedSpecs.current.clear()
      setStockMap({})
      setReloadToken((n) => n + 1)
    } catch (err) {
      setDeleteTarget(null)
      setActionError(err instanceof Error ? err.message : '删除失败')
    } finally {
      setDeleting(false)
    }
  }

  const handleSave = async () => {
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
        customer,
        order_date: form.orderDate,
        remark: form.remark.trim(),
        warehouse: form.warehouse.trim(),
        operator: form.operator.trim(),
        items,
      }
      const result = editing
        ? await updateOutbound(editing.id, payload)
        : await createOutbound(payload)
      setMode('list')
      setEditing(null)
      setForm({
        customer: '',
        orderDate: todayISO(),
        remark: '',
        warehouse: '',
        operator: '',
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
    } catch (err) {
      // 后端返回的库存不足信息原样展示，不吞掉
      setFormError(err instanceof Error ? err.message : '保存失败')
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
                onClose: () => setNotice(''),
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
                onClose: () => setFormError(''),
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
            <button className="btn" onClick={handleResetFilters}>
              重置
            </button>
            <span className="spacer" />
            <button className="btn btn-primary" onClick={openCreate}>
              新增出库
            </button>
          </div>

          <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>单号</th>
                <th>客户</th>
                <th>日期</th>
                <th>仓库</th>
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
                  <td>{order.customer}</td>
                  <td>{order.order_date}</td>
                  <td>{order.warehouse || '—'}</td>
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
            <EmptyState text="暂无出库单，点右上角「新增出库」录入" />
          )}
          {listLoading && <Loading />}
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
        <div className="card">
          <div className="field-row">
            <label className="field field-required">
              <span>客户</span>
              <input
                className="input"
                value={form.customer}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, customer: event.target.value }))
                }
              />
            </label>
            <label className="field">
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

            <table className="table table-detail">
            <thead>
              <tr>
                <th>规格</th>
                {specFields.map(({ field, label }) => (
                  <th key={field}>
                    {label}
                  </th>
                ))}
                {numberFields.map(({ field, label }) => (
                  <th key={field}>
                    {label}
                  </th>
                ))}
                <th className="num">立方</th>
                <th className="num">当前库存</th>
                <th className="num">金额</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {computedRows.map((row) => {
                const stock = row.specKey ? stockMap[row.specKey] : undefined
                const short = stock ? row.cubic > stock.cubic + EPSILON : false
                const reasons = rowErrors[row.key] ?? []
                const inputClassName =
                  reasons.length > 0
                    ? 'input input-cell input-error'
                    : 'input input-cell'
                return (
                  <Fragment key={row.key}>
                    <tr>
                      <td>
                        <button
                          className="btn btn-sm"
                          onClick={() => openPicker(row.key)}
                        >
                          选择规格
                        </button>
                      </td>
                      {specFields.map(({ field }) => (
                        <td key={field}>
                          <input
                            className={`${inputClassName} input-locked`}
                            type="text"
                            readOnly
                            placeholder="未选"
                            value={row[field]}
                          />
                        </td>
                      ))}
                      {numberFields.map(({ field }) => (
                        <td key={field}>
                          <input
                            className={inputClassName}
                            type="text"
                            inputMode="decimal"
                            value={row[field]}
                            onChange={(event) =>
                              updateRow(row.key, field, event.target.value)
                            }
                          />
                        </td>
                      ))}
                      <td className="num">{formatCubic(row.cubic)}</td>
                      <td className={short ? 'num is-short' : 'num'}>
                        {stock ? `${formatCubic(stock.cubic)} 立方 / ${stock.bundles} 件` : '—'}
                        {short ? ' 不足' : ''}
                      </td>
                      <td className="num amount">{formatAmount(row.amount)}</td>
                      <td>
                        <div className="row-actions">
                          <button
                            className="btn btn-sm btn-danger"
                            onClick={() => removeRow(row.key)}
                            disabled={rows.length === 1}
                          >
                            删一行
                          </button>
                        </div>
                      </td>
                    </tr>
                    {reasons.length > 0 && (
                      <tr>
                        <td colSpan={SPEC_ROW_COLUMNS} className="row-error">
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
            <span className="muted">
              点每行左侧「选择规格」从库存里挑规格；「当前库存」按该规格实时显示
              {editing ? '（修改时可用量 = 当前库存 + 本单原有数量）' : ''}
            </span>
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
                ? `正在修改出库单 ${editing.order_no}，单号不变，保存时会重新校验库存`
                : '单号保存时自动生成（CK + 日期 + 流水）'}
            </span>
          </div>
        </div>
      )}

      {(detail || detailLoading || detailError) && (
        <div className="overlay" onClick={closeDetail}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h2 className="modal-title">
                出库单详情{detail ? `：${detail.order_no}` : ''}
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
                  <span>客户：{detail.customer}</span>
                  <span>日期：{detail.order_date}</span>
                  <span>仓库：{detail.warehouse || '—'}</span>
                  <span>操作员：{detail.operator || '—'}</span>
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

      {pickerRowKey !== null && (
        <div className="overlay" onClick={() => setPickerRowKey(null)}>
          <div
            className="modal modal-wide"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <h2 className="modal-title">选择规格</h2>
              <button
                className="btn btn-sm btn-quiet"
                onClick={() => setPickerRowKey(null)}
              >
                关闭
              </button>
            </div>

            <div className="toolbar">
              <input
                className="input"
                placeholder="品名关键字"
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
              <span className="spacer" />
              <span className="muted">只列出有库存的规格</span>
            </div>

            <table className="table">
              <thead>
                <tr>
                  <th>品名</th>
                  <th>等级</th>
                  <th className="num">厚×宽×长</th>
                  <th className="num">当前件数</th>
                  <th className="num">当前片数</th>
                  <th className="num">当前立方</th>
                  <th className="num">最近入库单价</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {pickerRows.map((row) => (
                  <tr
                    key={[
                      row.species,
                      row.grade,
                      row.thickness,
                      row.width,
                      row.length,
                    ].join('|')}
                  >
                    <td>{row.species}</td>
                    <td>{row.grade || '—'}</td>
                    <td className="num">
                      {row.thickness}×{row.width}×{row.length}
                    </td>
                    <td className="num">{row.total_bundles}</td>
                    <td className="num">{row.total_pieces}</td>
                    <td className="num">{formatCubic(row.total_cubic)}</td>
                    <td className="num">
                      {row.last_unit_price === null
                        ? '—'
                        : formatAmount(row.last_unit_price)}
                    </td>
                    <td>
                      <button
                        className="btn btn-sm"
                        onClick={() => void applySpec(pickerKey, row)}
                      >
                        选择
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {!pickerLoading && pickerRows.length === 0 && (
              <EmptyState text="当前无任何库存，请先入库" />
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
            <h2 className="modal-title">删除确认</h2>
            <p className="confirm-text">
              确认删除出库单 {deleteTarget.order_no}？此操作不可恢复。
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
