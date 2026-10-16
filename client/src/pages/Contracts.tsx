import { useCallback, useEffect, useState } from 'react'
import {
  deleteContract,
  fetchContractDetail,
  fetchContracts,
  formatFileSize,
  openContractFile,
  saveContract,
  type ContractDetail,
  type ContractRow,
} from '../api'
import {
  EmptyState,
  Loading,
  PageHead,
  Pager,
  TableSkeleton,
  ToastHost,
} from '../components/Ui'
import { toNumber, formatAmount, todayLocal } from '../utils/num'
import { readListCache, writeListCache } from '../utils/listCache'
import { useRole } from '../hooks/useRole'
import { seesMoney } from '../permissions'
import { can } from '../permissions'

const PAGE_SIZE = 20

const emptyForm = () => ({
  contract_no: '',
  title: '',
  partner: '',
  sign_date: todayLocal(),
  amount: '',
  remark: '',
})

/** 合同明细行：只记「定了什么货」，不记长宽高 */
type ItemRow = {
  key: number
  brand: string
  species: string
  grade: string
  quantity: string
  unitPrice: string
}

let itemSeq = 0
const createItemRow = (): ItemRow => ({
  key: (itemSeq += 1),
  brand: '',
  species: '',
  grade: '',
  quantity: '',
  unitPrice: '',
})

const itemAmount = (row: ItemRow) => toNumber(row.quantity) * toNumber(row.unitPrice)
const isItemEmpty = (row: ItemRow) =>
  !row.brand.trim() && !row.species.trim() && !row.grade.trim() && !row.quantity.trim()

export default function Contracts() {
  /**
   * 看不到金额的角色：列表金额列、查看详情里的单价/金额、合同金额输入框都不显示。
   * 但**编辑表单里的单价列保留** —— 录合同的人得自己填（方案 A：输入可见可填）。
   * 编辑已有合同时前端拿不到原价，后端会把对得上的行原价补回去，不会清成 0。
   */
  const money = seesMoney(useRole())
  /** 只读角色不给上传 / 编辑 / 删除入口 */
  const canWrite = can(useRole(), 'contract.write')

  const [rows, setRows] = useState<ContractRow[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  /** 有缓存时后台静默刷新中 */
  const [refreshing, setRefreshing] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  // 查看（只读）弹层：明细要另拉一次详情接口
  const [viewing, setViewing] = useState<ContractDetail | null>(null)
  const [viewLoading, setViewLoading] = useState(false)

  const [input, setInput] = useState({
    keyword: '',
    partner: '',
    date_from: '',
    date_to: '',
  })
  const [filters, setFilters] = useState<{
    keyword?: string
    partner?: string
    date_from?: string
    date_to?: string
  }>({})
  const [reloadToken, setReloadToken] = useState(0)

  // 上传 / 编辑弹层
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editing, setEditing] = useState<ContractRow | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [items, setItems] = useState<ItemRow[]>(() => [createItemRow()])
  const [file, setFile] = useState<File | null>(null)
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)
  const [openingId, setOpeningId] = useState(0)

  const [deleteTarget, setDeleteTarget] = useState<ContractRow | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async (nextFilters: typeof filters, nextOffset: number) => {
    // 缓存先渲染 + 后台静默刷新（同入库/出库列表一个口径）
    const cacheKey = `contracts:${JSON.stringify(nextFilters)}:${nextOffset}`
    const cached = readListCache<{ rows: ContractRow[]; total: number }>(cacheKey)
    if (cached) {
      setRows(cached.rows)
      setTotal(cached.total)
      setRefreshing(true)
    } else {
      setLoading(true)
    }
    try {
      const result = await fetchContracts({
        ...nextFilters,
        limit: PAGE_SIZE,
        offset: nextOffset,
      })
      setRows(result.rows)
      setTotal(result.total)
      writeListCache(cacheKey, { rows: result.rows, total: result.total })
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load(filters, offset)
  }, [load, filters, offset, reloadToken])

  const handleSearch = () => {
    setOffset(0)
    setFilters({
      keyword: input.keyword.trim(),
      partner: input.partner.trim(),
      date_from: input.date_from,
      date_to: input.date_to,
    })
  }

  const handleReset = () => {
    setInput({ keyword: '', partner: '', date_from: '', date_to: '' })
    setOffset(0)
    setFilters({})
  }

  const openUpload = () => {
    setEditing(null)
    setForm(emptyForm())
    setItems([createItemRow()])
    setFile(null)
    setFormError('')
    setSheetOpen(true)
  }

  /** 查看：只读拉一次详情（含明细），不进编辑态 */
  const openView = async (row: ContractRow) => {
    setError('')
    setViewing({ ...row, items: [] })
    setViewLoading(true)
    try {
      setViewing(await fetchContractDetail(row.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取合同明细失败')
      setViewing(null)
    } finally {
      setViewLoading(false)
    }
  }

  const openEdit = (row: ContractRow) => {
    setEditing(row)
    setForm({
      contract_no: row.contract_no,
      title: row.title,
      partner: row.partner,
      sign_date: row.sign_date || todayLocal(),
      amount: row.amount ? String(row.amount) : '',
      remark: row.remark,
    })
    setItems([createItemRow()])
    setFile(null)
    setFormError('')
    setSheetOpen(true)
    // 明细单独拉一次（详情接口才带明细）
    void fetchContractDetail(row.id)
      .then((detail) => {
        if (detail.items && detail.items.length > 0) {
          setItems(
            detail.items.map((item) => ({
              key: (itemSeq += 1),
              brand: item.brand,
              species: item.species,
              grade: item.grade,
              quantity: String(item.quantity ?? ''),
              unitPrice: item.unit_price ? String(item.unit_price) : '',
            })),
          )
        }
      })
      .catch(() => {
        // 拿不到明细就留一行空的
      })
  }

  const submit = async () => {
    const contractNo = form.contract_no.trim()
    if (!contractNo) {
      setFormError('合同号不能为空')
      return
    }
    if (file && !file.name.toLowerCase().endsWith('.pdf')) {
      setFormError('合同必须是 PDF 格式')
      return
    }

    const payload = new FormData()
    payload.append('contract_no', contractNo)
    payload.append('title', form.title.trim())
    payload.append('partner', form.partner.trim())
    payload.append('sign_date', form.sign_date)
    payload.append('amount', form.amount || '0')
    payload.append('remark', form.remark.trim())
    payload.append('items', JSON.stringify(
      items
        .filter((row) => !isItemEmpty(row))
        .map((row) => ({
          brand: row.brand.trim(),
          species: row.species.trim(),
          grade: row.grade.trim(),
          quantity: toNumber(row.quantity),
          unit_price: toNumber(row.unitPrice),
        })),
    ))
    if (file) payload.append('file', file)

    setSaving(true)
    setFormError('')
    try {
      await saveContract(payload, editing?.id)
      setSheetOpen(false)
      setNotice(editing ? `已保存合同 ${contractNo}` : `已上传合同 ${contractNo}`)
      setOffset(0)
      setReloadToken((n) => n + 1)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleOpen = async (row: ContractRow) => {
    setOpeningId(row.id)
    setError('')
    try {
      await openContractFile(row.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : '打开合同失败')
    } finally {
      setOpeningId(0)
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await deleteContract(deleteTarget.id)
      setNotice(`已把合同 ${deleteTarget.contract_no} 移入回收站`)
      setDeleteTarget(null)
      setReloadToken((n) => n + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : '移入回收站失败')
      setDeleteTarget(null)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <section>
      <PageHead
        title="采购合同"
        subtitle="登记合同与明细（PDF 选填）；入库单填了合同号就能直接打开对应合同"
        extra={
          canWrite ? (
            <button className="btn btn-primary" onClick={openUpload}>
              上传合同
            </button>
          ) : null
        }
      />

      <ToastHost
        items={[
          notice
            ? {
                id: 'contract-notice',
                kind: 'success' as const,
                message: notice,
                onClose: () => setNotice(''),
              }
            : null,
          error
            ? {
                id: 'contract-error',
                kind: 'error' as const,
                message: error,
                onClose: () => setError(''),
              }
            : null,
        ]}
      />

      <div className="toolbar">
        <input
          className="input"
          placeholder="合同号 / 名称关键字"
          value={input.keyword}
          onChange={(event) => setInput((prev) => ({ ...prev, keyword: event.target.value }))}
          onKeyDown={(event) => {
            if (event.key === 'Enter') handleSearch()
          }}
        />
        <input
          className="input"
          placeholder="往来单位"
          value={input.partner}
          onChange={(event) => setInput((prev) => ({ ...prev, partner: event.target.value }))}
          onKeyDown={(event) => {
            if (event.key === 'Enter') handleSearch()
          }}
        />
        <input
          className="input"
          type="date"
          value={input.date_from}
          onChange={(event) => setInput((prev) => ({ ...prev, date_from: event.target.value }))}
        />
        <span className="muted">至</span>
        <input
          className="input"
          type="date"
          value={input.date_to}
          onChange={(event) => setInput((prev) => ({ ...prev, date_to: event.target.value }))}
        />
        <button className="btn" onClick={handleSearch}>
          查询
        </button>
        <button className="btn" onClick={handleReset}>
          重置
        </button>
        {refreshing && <span className="list-refreshing">刷新中…</span>}
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>合同号</th>
              <th>名称</th>
              <th>往来单位</th>
              <th>签订日期</th>
              {money && <th className="num">金额</th>}
              <th>文件</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.contract_no}</td>
                <td>{row.title || '—'}</td>
                <td>{row.partner || '—'}</td>
                <td>{row.sign_date}</td>
                {money && <td className="num amount">{formatAmount(row.amount)}</td>}
                <td>
                  {row.has_file ? (
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => void handleOpen(row)}
                      disabled={openingId === row.id}
                    >
                      {openingId === row.id ? '打开中…' : '打开 PDF'}
                    </button>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  <div className="row-actions">
                    <button className="btn btn-sm" onClick={() => void openView(row)}>
                      查看
                    </button>
                    {canWrite && (
                      <>
                        <button className="btn btn-sm" onClick={() => openEdit(row)}>
                          编辑
                        </button>
                        <button
                          className="btn btn-sm btn-danger"
                          title="移入回收站，可在回收站恢复"
                          onClick={() => setDeleteTarget(row)}
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

        {!loading && rows.length === 0 && (
          <EmptyState
            text="还没有合同"
            hint="上传一份合同（PDF 选填），后面的入库单就能挂到它下面"
            action={canWrite ? { label: '上传合同', onClick: openUpload } : undefined}
          />
        )}
        {loading && <TableSkeleton rows={6} cols={5} />}

        <Pager
          total={total}
          limit={PAGE_SIZE}
          offset={offset}
          onChange={setOffset}
          unit="份合同"
        />
      </div>

      {sheetOpen && (
        <div className="overlay" onClick={() => setSheetOpen(false)}>
          <div
            className="modal modal-xwide modal-sheet"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <h2 className="modal-title">{editing ? '编辑合同' : '上传合同'}</h2>
              <button
                className="btn btn-sm btn-quiet"
                onClick={() => setSheetOpen(false)}
              >
                关闭
              </button>
            </div>

            <label className="field field-required">
              <span>合同号</span>
              <input
                className="input"
                placeholder="例如：HT20261013001（要和入库单上填的一致）"
                value={form.contract_no}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, contract_no: event.target.value }))
                }
              />
            </label>

            <label className="field" style={{ marginTop: 14 }}>
              <span>合同名称</span>
              <input
                className="input"
                value={form.title}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, title: event.target.value }))
                }
              />
            </label>

            <label className="field" style={{ marginTop: 14 }}>
              <span>往来单位</span>
              <input
                className="input"
                placeholder="供应商 / 客户"
                value={form.partner}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, partner: event.target.value }))
                }
              />
            </label>

            <label className="field" style={{ marginTop: 14 }}>
              <span>签订日期</span>
              <input
                className="input"
                type="date"
                value={form.sign_date}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, sign_date: event.target.value }))
                }
              />
            </label>

            {/*
              合同金额是明细合计，后端会用明细重算，这里只是个方便核对输入框 ——
              看不到金额的角色不显示（他们的明细里本来也没有原价可核）
            */}
            {money && (
              <label className="field" style={{ marginTop: 14 }}>
                <span>合同金额（元）</span>
                <input
                  className="input"
                  inputMode="decimal"
                  value={form.amount}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, amount: event.target.value }))
                  }
                />
              </label>
            )}

            <label className="field" style={{ marginTop: 14 }}>
              <span>备注</span>
              <input
                className="input"
                value={form.remark}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, remark: event.target.value }))
                }
              />
            </label>

            <label className="field" style={{ marginTop: 14 }}>
              <span>
                {editing ? '更换合同文件（PDF，留空则不改）' : '合同文件（PDF，选填）'}
              </span>
              <input
                className="input"
                type="file"
                accept="application/pdf,.pdf"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </label>

            {/* 合同明细：只记定了什么货，长宽高不在合同上定 */}
            <h3 className="section-title" style={{ marginTop: 22 }}>
              合同明细（定了什么货）
            </h3>
            <table className="sheet-table">
              <thead>
                <tr>
                  <th className="col-no">#</th>
                  <th className="col-op">操作</th>
                  <th>品牌</th>
                  <th>品名 *</th>
                  <th>等级</th>
                  <th>数量 (m³)</th>
                  {/* 单价要留着：录合同的人得自己填（方案 A —— 输入可见可填） */}
                  <th>单价 (元/m³)</th>
                  {money && <th>金额 (元)</th>}
                </tr>
              </thead>
              <tbody>
                {items.map((row, index) => (
                  <tr key={row.key}>
                    <td className="col-no">{index + 1}</td>
                    <td className="col-op">
                      <button
                        type="button"
                        className="sheet-icon sheet-icon-danger"
                        title="删掉这一行"
                        onClick={() =>
                          setItems((prev) =>
                            prev.length > 1 ? prev.filter((item) => item.key !== row.key) : prev,
                          )
                        }
                      >
                        ✕
                      </button>
                    </td>
                    {(['brand', 'species', 'grade', 'quantity', 'unitPrice'] as const).map((field) => (
                      <td key={field}>
                        <input
                          className="sheet-input"
                          type="text"
                          inputMode={
                            field === 'quantity' || field === 'unitPrice' ? 'decimal' : undefined
                          }
                          value={row[field]}
                          onChange={(event) =>
                            setItems((prev) =>
                              prev.map((item) =>
                                item.key === row.key
                                  ? { ...item, [field]: event.target.value }
                                  : item,
                              ),
                            )
                          }
                        />
                      </td>
                    ))}
                    <td className="num">
                      {money && (itemAmount(row) ? itemAmount(row).toFixed(2) : '')}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={5} className="sheet-total-label">
                    合计
                  </td>
                  <td className="num">
                    {items.reduce((sum, row) => sum + toNumber(row.quantity), 0) || ''}
                  </td>
                  {/* 单价列始终占位，金额列只有看得到金额的角色才有 */}
                  <td />
                  {money && (
                    <td className="num">
                      {items.reduce((sum, row) => sum + itemAmount(row), 0).toFixed(2)}
                    </td>
                  )}
                </tr>
              </tfoot>
            </table>
            <div className="sheet-toolbar">
              <button className="btn btn-sm" onClick={() => setItems((prev) => [...prev, createItemRow()])}>
                + 加一行
              </button>
              <span className="spacer" />
              <span className="muted">合同金额 = 明细金额合计（按数量 × 单价自动算）</span>
            </div>

            {editing?.has_file && !file && (
              <p className="hint" style={{ marginTop: 8 }}>
                当前文件：{editing.file_original}（{formatFileSize(editing.file_size)}）
              </p>
            )}

            {formError && <p className="login-error">{formError}</p>}

            <div className="confirm-actions">
              <button
                className="btn"
                onClick={() => setSheetOpen(false)}
                disabled={saving}
              >
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void submit()}
                disabled={saving}
              >
                {saving ? '提交中…' : editing ? '确认修改' : '确认上传'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 查看：只读，明细看这里，不是编辑 */
      }
      {viewing && (
        <div className="overlay" onClick={() => setViewing(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h2 className="modal-title">合同详情：{viewing.contract_no}</h2>
              <div className="modal-actions">
                {viewing.has_file && (
                  <button
                    className="btn btn-sm"
                    onClick={() => void handleOpen(viewing)}
                    disabled={openingId === viewing.id}
                  >
                    {openingId === viewing.id ? '打开中…' : '打开 PDF'}
                  </button>
                )}
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    const row = viewing
                    setViewing(null)
                    openEdit(row)
                  }}
                >
                  编辑
                </button>
                <button className="btn btn-quiet" onClick={() => setViewing(null)}>
                  关闭
                </button>
              </div>
            </div>

            <div className="meta">
              <span>名称：{viewing.title || '—'}</span>
              <span>往来单位：{viewing.partner || '—'}</span>
              <span>签订日期：{viewing.sign_date || '—'}</span>
              {money && <span>合同金额：{formatAmount(viewing.amount)} 元</span>}
              <span>备注：{viewing.remark || '—'}</span>
              <span>
                文件：
                {viewing.has_file
                  ? `${viewing.file_original}（${formatFileSize(viewing.file_size)}）`
                  : '未上传（选填）'}
              </span>
              <span>创建时间：{viewing.created_at}</span>
            </div>

            <h3 className="section-title" style={{ marginTop: 4 }}>
              合同明细（{viewing.items.length} 行）
            </h3>
            {viewLoading ? (
              <Loading />
            ) : viewing.items.length === 0 ? (
              <p className="muted">这份合同还没有登记明细。</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>品牌</th>
                    <th>品名</th>
                    <th>等级</th>
                    <th className="num">数量 (m³)</th>
                    {money && <th className="num">单价 (元/m³)</th>}
                    {money && <th className="num">金额 (元)</th>}
                  </tr>
                </thead>
                <tbody>
                  {viewing.items.map((item) => (
                    <tr key={item.id}>
                      <td>{item.brand || '—'}</td>
                      <td>{item.species}</td>
                      <td>{item.grade || '—'}</td>
                      <td className="num">{formatAmount(item.quantity)}</td>
                      {money && <td className="num">{formatAmount(item.unit_price)}</td>}
                      {money && <td className="num">{formatAmount(item.amount)}</td>}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3}>合计</td>
                    <td className="num">
                      {formatAmount(
                        viewing.items.reduce((sum, item) => sum + item.quantity, 0),
                      )}
                    </td>
                    {money && <td />}
                    {money && <td className="num">{formatAmount(viewing.amount)}</td>}
                  </tr>
                </tfoot>
              </table>
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
            <h2 className="modal-title">移入回收站</h2>
            <p className="confirm-text">
              确认把合同 {deleteTarget.contract_no}
              {deleteTarget.title ? `（${deleteTarget.title}）` : ''} 移入回收站？
              <br />
              这张合同下面的提单、入库单和包会一起移进去（回收站里能整串恢复）；
              合同文件保留在服务器上。
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
    </section>
  )
}
