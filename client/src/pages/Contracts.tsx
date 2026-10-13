import { useCallback, useEffect, useState } from 'react'
import {
  deleteContract,
  fetchContracts,
  formatFileSize,
  openContractFile,
  saveContract,
  type ContractRow,
} from '../api'
import { EmptyState, Loading, PageHead, Pager, ToastHost } from '../components/Ui'

const PAGE_SIZE = 20

const formatAmount = (value: number) => value.toFixed(2)

function todayLocal() {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

const emptyForm = () => ({
  contract_no: '',
  title: '',
  partner: '',
  sign_date: todayLocal(),
  amount: '',
  remark: '',
})

export default function Contracts() {
  const [rows, setRows] = useState<ContractRow[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

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
  const [file, setFile] = useState<File | null>(null)
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)
  const [openingId, setOpeningId] = useState(0)

  const [deleteTarget, setDeleteTarget] = useState<ContractRow | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async (nextFilters: typeof filters, nextOffset: number) => {
    setLoading(true)
    try {
      const result = await fetchContracts({
        ...nextFilters,
        limit: PAGE_SIZE,
        offset: nextOffset,
      })
      setRows(result.rows)
      setTotal(result.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
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
    setFile(null)
    setFormError('')
    setSheetOpen(true)
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
    setFile(null)
    setFormError('')
    setSheetOpen(true)
  }

  const submit = async () => {
    const contractNo = form.contract_no.trim()
    if (!contractNo) {
      setFormError('合同号不能为空')
      return
    }
    if (!editing && !file) {
      setFormError('请选择要上传的 PDF 合同文件')
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
      setNotice(`已删除合同 ${deleteTarget.contract_no}`)
      setDeleteTarget(null)
      setReloadToken((n) => n + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
      setDeleteTarget(null)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <section>
      <PageHead
        title="合同"
        subtitle="上传并管理 PDF 合同；入库单填了合同号就能直接打开对应合同"
        extra={
          <button className="btn btn-primary" onClick={openUpload}>
            上传合同
          </button>
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
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>合同号</th>
              <th>名称</th>
              <th>往来单位</th>
              <th>签订日期</th>
              <th className="num">金额</th>
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
                <td className="num amount">{formatAmount(row.amount)}</td>
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
                    <button className="btn btn-sm" onClick={() => openEdit(row)}>
                      编辑
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => setDeleteTarget(row)}
                    >
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {!loading && rows.length === 0 && (
          <EmptyState text="还没有合同，点右上角「上传合同」添加" />
        )}
        {loading && <Loading />}

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
            className="modal modal-narrow modal-sheet"
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
              <span>{editing ? '更换合同文件（PDF，留空则不改）' : '合同文件（PDF）'}</span>
              <input
                className="input"
                type="file"
                accept="application/pdf,.pdf"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </label>

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

      {deleteTarget && (
        <div className="overlay" onClick={() => setDeleteTarget(null)}>
          <div
            className="modal modal-narrow modal-alert"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="modal-title">删除合同</h2>
            <p className="confirm-text">
              确认删除合同 {deleteTarget.contract_no}
              {deleteTarget.title ? `（${deleteTarget.title}）` : ''}？文件会保留在服务器上。
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
