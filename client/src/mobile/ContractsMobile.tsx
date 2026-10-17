import { useCallback, useEffect, useState } from 'react'
import {
  deleteContract,
  fetchContractDetail,
  fetchContractPicker,
  openContractFile,
  saveContract,
  type ContractDetail,
  type ContractPickerRow,
} from '../api'
import { can, seesMoney } from '../permissions'
import { useRole } from '../hooks/useRole'
import { formatAmount, formatCubic, todayLocal, toNumber } from '../utils/num'
import { contractStage } from '../utils/contractStatus'
import { tapHeavy, tapLight, tapMedium } from '../utils/haptics'
import SuccessToast from '../components/SuccessToast'
import {
  MobileCard,
  MobileEmpty,
  MobileInput,
  MobileList,
  MobileListItem,
  MobileModal,
  MobileSearchBar,
  MobileSheet,
  MobileSkeleton,
  MobileStatusTag,
  MobileToastHost,
  MobileTopbarActions,
  MobileTopbarButton,
  useAutoDismiss,
  type MobileToastItem,
} from './components'

type ItemRow = {
  key: number
  brand: string
  species: string
  grade: string
  quantity: string
  unitPrice: string
}

let itemSeq = 0
const createItem = (): ItemRow => ({
  key: (itemSeq += 1),
  brand: '',
  species: '',
  grade: '',
  quantity: '',
  unitPrice: '',
})

const emptyForm = () => ({
  contract_no: '',
  title: '',
  partner: '',
  sign_date: todayLocal(),
  amount: '',
  remark: '',
})

export default function ContractsMobile() {
  const role = useRole()
  const money = seesMoney(role)
  const canWrite = can(role, 'contract.write')
  const [keyword, setKeyword] = useState('')
  const [debounced, setDebounced] = useState('')
  const [rows, setRows] = useState<ContractPickerRow[]>([])
  const [loading, setLoading] = useState(true)
  const [reloadToken, setReloadToken] = useState(0)
  const [detail, setDetail] = useState<ContractDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<ContractPickerRow | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [items, setItems] = useState<ItemRow[]>(() => [createItem()])
  const [file, setFile] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)
  const [opening, setOpening] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ContractPickerRow | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [toast, setToast] = useState<MobileToastItem | null>(null)
  const [success, setSuccess] = useState<{ title: string; subtitle: string } | null>(null)
  useAutoDismiss(toast, () => setToast(null))

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(keyword.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [keyword])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await fetchContractPicker({ keyword: debounced || undefined, limit: 100 })
      setRows(result.rows)
    } catch (err) {
      setToast({
        id: `c-${Date.now()}`,
        message: err instanceof Error ? err.message : '加载合同失败',
      })
    } finally {
      setLoading(false)
    }
  }, [debounced])

  useEffect(() => {
    void load()
  }, [load, reloadToken])

  const openDetail = async (row: ContractPickerRow) => {
    tapLight()
    setDetailLoading(true)
    try {
      setDetail(await fetchContractDetail(row.id))
    } catch (err) {
      setToast({
        id: `d-${Date.now()}`,
        message: err instanceof Error ? err.message : '读取合同详情失败',
      })
    } finally {
      setDetailLoading(false)
    }
  }

  const openNew = () => {
    setDetail(null)
    setEditing(null)
    setForm(emptyForm())
    setItems([createItem()])
    setFile(null)
    setFormOpen(true)
  }

  const openEdit = async (row: ContractPickerRow) => {
    setDetail(null)
    setEditing(row)
    setForm({
      contract_no: row.contract_no,
      title: row.title,
      partner: row.partner,
      sign_date: row.sign_date || todayLocal(),
      amount: row.amount ? String(row.amount) : '',
      remark: '',
    })
    setItems([createItem()])
    setFile(null)
    setFormOpen(true)
    try {
      const full = await fetchContractDetail(row.id)
      setForm({
        contract_no: full.contract_no,
        title: full.title,
        partner: full.partner,
        sign_date: full.sign_date || todayLocal(),
        amount: full.amount ? String(full.amount) : '',
        remark: full.remark || '',
      })
      setItems(
        full.items.length > 0
          ? full.items.map((item) => ({
              key: (itemSeq += 1),
              brand: item.brand || '',
              species: item.species || '',
              grade: item.grade || '',
              quantity: String(item.quantity ?? ''),
              unitPrice: item.unit_price ? String(item.unit_price) : '',
            }))
          : [createItem()],
      )
    } catch (err) {
      setToast({
        id: `e-${Date.now()}`,
        message: err instanceof Error ? err.message : '读取合同明细失败',
      })
    }
  }

  const submit = async () => {
    const contractNo = form.contract_no.trim()
    if (!contractNo) {
      setToast({ id: `v-${Date.now()}`, message: '合同号不能为空' })
      return
    }
    if (file && !file.name.toLowerCase().endsWith('.pdf')) {
      setToast({ id: `v-${Date.now()}`, message: '合同必须是 PDF 格式' })
      return
    }
    const payload = new FormData()
    payload.append('contract_no', contractNo)
    payload.append('title', form.title.trim())
    payload.append('partner', form.partner.trim())
    payload.append('sign_date', form.sign_date)
    payload.append('amount', form.amount || '0')
    payload.append('remark', form.remark.trim())
    payload.append(
      'items',
      JSON.stringify(
        items
          .filter(
            (row) =>
              row.brand.trim() ||
              row.species.trim() ||
              row.grade.trim() ||
              row.quantity.trim(),
          )
          .map((row) => ({
            brand: row.brand.trim(),
            species: row.species.trim(),
            grade: row.grade.trim(),
            quantity: toNumber(row.quantity),
            unit_price: toNumber(row.unitPrice),
          })),
      ),
    )
    if (file) payload.append('file', file)
    setSaving(true)
    try {
      await saveContract(payload, editing?.id)
      setFormOpen(false)
      setDetail(null)
      setReloadToken((value) => value + 1)
      setSuccess({
        title: '已录入',
        subtitle: `合同号 ${contractNo} 保存成功`,
      })
    } catch (err) {
      setToast({
        id: `s-${Date.now()}`,
        message: err instanceof Error ? err.message : '保存失败',
      })
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await deleteContract(deleteTarget.id)
      setDeleteTarget(null)
      setDetail(null)
      setReloadToken((value) => value + 1)
      setToast({
        id: `del-${Date.now()}`,
        message: `已把合同 ${deleteTarget.contract_no} 移入回收站`,
      })
    } catch (err) {
      setToast({
        id: `del-${Date.now()}`,
        message: err instanceof Error ? err.message : '移入回收站失败',
      })
    } finally {
      setDeleting(false)
    }
  }

  const detailPickerRow = detail ? rows.find((row) => row.id === detail.id) : undefined
  const detailStage = detailPickerRow
    ? contractStage(detailPickerRow)
    : { label: '已录入' as const, tone: 'neutral' as const }

  return (
    <div className="m-stack">
      {canWrite ? (
        <MobileTopbarActions>
          <MobileTopbarButton label="＋" onClick={openNew} />
        </MobileTopbarActions>
      ) : null}

      <MobileSearchBar
        value={keyword}
        placeholder="合同号 / 名称 / 往来单位"
        onChange={setKeyword}
      />

      {loading ? (
        <MobileSkeleton cards={3} />
      ) : rows.length === 0 ? (
        <MobileEmpty
          text={debounced ? '没有匹配的合同' : '还没有合同'}
          actionLabel={canWrite ? '上传合同' : undefined}
          onAction={canWrite ? openNew : undefined}
        />
      ) : (
        <MobileList>
          {rows.map((row) => (
            <MobileListItem
              key={row.id}
              dense
              title={row.contract_no}
              sub={`${row.partner || '—'} · 已入 ${formatCubic(row.in_cubic)} m³ · 进度 ${row.in_bundles}/${row.total_qty} 件`}
              trail={
                <MobileStatusTag tone={contractStage(row).tone}>
                  {contractStage(row).label}
                </MobileStatusTag>
              }
              onClick={() => void openDetail(row)}
            />
          ))}
        </MobileList>
      )}

      <MobileSheet
        open={Boolean(detail) || detailLoading}
        title={detail?.contract_no || '合同详情'}
        titleExtra={
          detail ? (
            <MobileStatusTag tone={detailStage.tone} large>
              {detailStage.label}
            </MobileStatusTag>
          ) : undefined
        }
        onClose={() => setDetail(null)}
      >
        {detail ? (
          <>
            <div className="m-rows">
              {[
                ['名称', detail.title || '—'],
                ['往来单位', detail.partner || '—'],
                ['签订日期', detail.sign_date || '—'],
                ...(money ? [['合同金额', `${formatAmount(detail.amount)} 元`, true]] : []),
                ['明细行数', String(detail.items.length)],
                ['备注', detail.remark || '—'],
              ].map(([label, value, numeric]) => (
                <div className="m-row" key={String(label)}>
                  <span className="m-row-label">{String(label)}</span>
                  <span className={numeric ? 'm-row-value is-num' : 'm-row-value'}>
                    {String(value)}
                  </span>
                </div>
              ))}
            </div>
            <div className="m-detail-title">合同明细</div>
            {detail.items.map((item) => (
              <div className="m-contract-item" key={item.id}>
                <b>{[item.brand, item.species, item.grade].filter(Boolean).join(' · ') || '—'}</b>
                <span>
                  {item.quantity} 件
                  {money ? ` · ${formatAmount(item.unit_price)} 元` : ''}
                </span>
              </div>
            ))}
            <div className="m-sheet-actions">
              {detail.has_file ? (
                <button
                  type="button"
                  className="m-btn m-btn-ghost"
                  disabled={opening}
                  onClick={() => {
                    setOpening(true)
                    void openContractFile(detail.id)
                      .catch((err: unknown) =>
                        setToast({
                          id: `pdf-${Date.now()}`,
                          message: err instanceof Error ? err.message : '打开合同失败',
                        }),
                      )
                      .finally(() => setOpening(false))
                  }}
                >
                  {opening ? '打开中…' : '打开 PDF'}
                </button>
              ) : null}
              {canWrite ? (
                <button
                  type="button"
                  className="m-btn m-btn-ghost"
                  onClick={() => {
                    const row = rows.find((one) => one.id === detail.id)
                    if (row) void openEdit(row)
                  }}
                >
                  编辑
                </button>
              ) : null}
              {canWrite ? (
                <button
                  type="button"
                  className="m-btn m-btn-danger"
                  onClick={() => {
                    const row = rows.find((one) => one.id === detail.id)
                    if (row) {
                      tapHeavy()
                      setDeleteTarget(row)
                    }
                  }}
                >
                  移入回收站
                </button>
              ) : null}
            </div>
          </>
        ) : null}
      </MobileSheet>

      <MobileSheet
        open={formOpen}
        title={editing ? '编辑合同' : '上传合同'}
        onClose={() => setFormOpen(false)}
      >
        <MobileCard title="基本信息">
          <MobileInput
            label="合同号 *"
            value={form.contract_no}
            onChange={(value) => setForm((prev) => ({ ...prev, contract_no: value }))}
          />
          <MobileInput
            label="合同名称"
            value={form.title}
            onChange={(value) => setForm((prev) => ({ ...prev, title: value }))}
          />
          <MobileInput
            label="往来单位"
            value={form.partner}
            onChange={(value) => setForm((prev) => ({ ...prev, partner: value }))}
          />
          <label className="m-field">
            <span className="m-field-label">签订日期</span>
            <input
              className="m-input"
              type="date"
              value={form.sign_date}
              onChange={(event) => setForm((prev) => ({ ...prev, sign_date: event.target.value }))}
            />
          </label>
          {money ? (
            <MobileInput
              label="合同金额（元）"
              value={form.amount}
              inputMode="decimal"
              onChange={(value) => setForm((prev) => ({ ...prev, amount: value }))}
            />
          ) : null}
          <MobileInput
            label="备注"
            value={form.remark}
            onChange={(value) => setForm((prev) => ({ ...prev, remark: value }))}
          />
          <label className="m-field">
            <span className="m-field-label">合同 PDF（选填）</span>
            <input
              className="m-file-input"
              type="file"
              accept=".pdf,application/pdf"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
        </MobileCard>

        <MobileCard title="合同明细" hint={`${items.length} 行`}>
          {items.map((item, index) => (
            <div className="m-contract-form-row" key={item.key}>
              <div className="m-line-editor-head">
                <span>第 {index + 1} 行</span>
                <button
                  type="button"
                  className="m-icon-btn"
                  disabled={items.length <= 1}
                  onClick={() => setItems((prev) => prev.filter((row) => row.key !== item.key))}
                >
                  ✕
                </button>
              </div>
              <div className="m-line-grid m-line-grid-3">
                <label className="m-line-field">
                  <span className="m-line-label">品牌</span>
                  <input
                    className="m-line-input"
                    value={item.brand}
                    onChange={(event) =>
                      setItems((prev) =>
                        prev.map((row) =>
                          row.key === item.key ? { ...row, brand: event.target.value } : row,
                        ),
                      )
                    }
                  />
                </label>
                <label className="m-line-field">
                  <span className="m-line-label">品名</span>
                  <input
                    className="m-line-input"
                    value={item.species}
                    onChange={(event) =>
                      setItems((prev) =>
                        prev.map((row) =>
                          row.key === item.key ? { ...row, species: event.target.value } : row,
                        ),
                      )
                    }
                  />
                </label>
                <label className="m-line-field">
                  <span className="m-line-label">等级</span>
                  <input
                    className="m-line-input"
                    value={item.grade}
                    onChange={(event) =>
                      setItems((prev) =>
                        prev.map((row) =>
                          row.key === item.key ? { ...row, grade: event.target.value } : row,
                        ),
                      )
                    }
                  />
                </label>
              </div>
              <div className="m-line-grid m-line-grid-2">
                <label className="m-line-field">
                  <span className="m-line-label">数量</span>
                  <input
                    className="m-line-input"
                    inputMode="decimal"
                    value={item.quantity}
                    onChange={(event) =>
                      setItems((prev) =>
                        prev.map((row) =>
                          row.key === item.key ? { ...row, quantity: event.target.value } : row,
                        ),
                      )
                    }
                  />
                </label>
                <label className="m-line-field">
                  <span className="m-line-label">单价</span>
                  <input
                    className="m-line-input"
                    inputMode="decimal"
                    value={item.unitPrice}
                    onChange={(event) =>
                      setItems((prev) =>
                        prev.map((row) =>
                          row.key === item.key ? { ...row, unitPrice: event.target.value } : row,
                        ),
                      )
                    }
                  />
                </label>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="m-btn m-btn-ghost m-add-row"
            onClick={() => setItems((prev) => [...prev, createItem()])}
          >
            + 添加明细
          </button>
        </MobileCard>

        <div className="m-sheet-actions">
          <button
            type="button"
            className="m-btn m-btn-primary"
            disabled={saving}
            onClick={() => {
              tapMedium()
              void submit()
            }}
          >
            {saving ? '保存中…' : '保存'}
          </button>
          <button type="button" className="m-btn m-btn-ghost" onClick={() => setFormOpen(false)}>
            取消
          </button>
        </div>
      </MobileSheet>

      <MobileModal
        open={Boolean(deleteTarget)}
        title="移入回收站？"
        message={
          deleteTarget
            ? `合同 ${deleteTarget.contract_no} 会被移入回收站，之后可以恢复。`
            : undefined
        }
        confirmLabel={deleting ? '处理中…' : '确认移入'}
        danger
        onConfirm={() => void confirmDelete()}
        onClose={() => {
          if (!deleting) setDeleteTarget(null)
        }}
      />

      <MobileToastHost items={[toast]} />
      <SuccessToast
        open={Boolean(success)}
        title={success?.title ?? ''}
        subtitle={success?.subtitle ?? ''}
        onDone={() => setSuccess(null)}
      />
    </div>
  )
}
