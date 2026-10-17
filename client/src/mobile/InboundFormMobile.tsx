/**
 * 采购入库表单 · 手机版（检查点5）。
 *
 * 流程保留：选方式（底部 sheet）→ 按提单 / 按合同 → 表头 + 明细 → 保存。
 * 前端把服务端三条硬规则提前拦住：包号个数=件数（按包号自动定件数）、
 * 包号不重复（含后端全局唯一预检）、柜号不跨提单（后端兜底）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  createInbound,
  fetchBales,
  fetchContractOptions,
  type ContractOption,
  type InboundItemPayload,
} from '../api'
import { todayISO, toNumber } from '../utils/num'
import { tapHeavy, tapLight, tapMedium } from '../utils/haptics'
import { useKeyboardScroll } from '../hooks/useKeyboardScroll'
import { goBack } from './nav'
import {
  MobileCard,
  MobileEmpty,
  MobileInput,
  MobileSearchBar,
  MobileSheet,
  MobileSkeleton,
  MobileToastHost,
  MobileTopbarActions,
  MobileTopbarButton,
  useAutoDismiss,
  type MobileToastItem,
} from './components'

type Row = {
  key: number
  baleLabel: string
  thickness: string
  width: string
  length: string
  species: string
  brand: string
  grade: string
  pieces: string
  bundles: string
  unitPrice: string
}

let seq = 1
const emptyRow = (): Row => ({
  key: seq++,
  baleLabel: '',
  thickness: '',
  width: '',
  length: '',
  species: '',
  brand: '',
  grade: '',
  pieces: '',
  bundles: '',
  unitPrice: '',
})

/** 包号支持 P1、P2、P3 / P1,P2 两种写法 */
const parseLabels = (raw: string) =>
  raw
    .split(/[、,，/\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)

type RowError = { key: number; messages: string[]; firstField: keyof Row | null }

export default function InboundFormMobile() {
  const navigate = useNavigate()
  useKeyboardScroll(true)
  const [methodOpen, setMethodOpen] = useState(true)
  /** 已经选好的录入方式（direct=按提单 / contract=按合同），选完收起选择区 */
  const [method, setMethod] = useState<'direct' | 'contract' | null>(null)
  const [supplier, setSupplier] = useState('')
  const [orderDate, setOrderDate] = useState(todayISO())
  const [blNo, setBlNo] = useState('')
  const [contractNo, setContractNo] = useState('')
  const [warehouse, setWarehouse] = useState('')
  const [operator, setOperator] = useState('')
  const [remark, setRemark] = useState('')
  const [rows, setRows] = useState<Row[]>([emptyRow()])
  const [rowErrors, setRowErrors] = useState<Record<number, string[]>>({})
  /** 表头级错误：挂在基本信息卡顶部红字提示 */
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<MobileToastItem | null>(null)
  useAutoDismiss(toast, () => setToast(null))

  const [contractOpen, setContractOpen] = useState(false)
  const [contractKeyword, setContractKeyword] = useState('')
  const [contracts, setContracts] = useState<ContractOption[]>([])
  const [contractLoading, setContractLoading] = useState(false)
  const supplierRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!contractOpen) return
    setContractLoading(true)
    void fetchContractOptions()
      .then((list) =>
        setContracts(
          contractKeyword.trim()
            ? list.filter((item) =>
                `${item.contract_no}${item.partner}${item.title}`
                  .toLowerCase()
                  .includes(contractKeyword.trim().toLowerCase()),
              )
            : list,
        ),
      )
      .catch(() => undefined)
      .finally(() => setContractLoading(false))
  }, [contractOpen, contractKeyword])

  const updateRow = useCallback((key: number, field: keyof Row, value: string) => {
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, [field]: value } : row)))
    setRowErrors((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [])

  const addRow = () => setRows((prev) => [...prev, emptyRow()])
  const copyPrev = (index: number) => {
    if (index <= 0) return
    tapLight()
    setRows((prev) => {
      const src = prev[index - 1]
      const next = [...prev]
      next[index] = { ...src, key: prev[index].key, baleLabel: '' }
      return next
    })
  }
  const removeRow = (key: number) => {
    tapHeavy()
    setRows((prev) => (prev.length > 1 ? prev.filter((row) => row.key !== key) : prev))
  }

  const totalCubic = useMemo(
    () =>
      rows.reduce((sum, row) => {
        const cubic =
          (toNumber(row.thickness) * toNumber(row.width) * toNumber(row.length) * toNumber(row.pieces)) /
          1_000_000
        return sum + cubic
      }, 0),
    [rows],
  )

  /** 前端校验：把服务端会 400 的问题在这里拦住 */
  const validate = (): { errors: RowError[]; form: string } => {
    const errors: RowError[] = []
    const seen = new Set<string>()
    rows.forEach((row) => {
      const messages: string[] = []
      let firstField: keyof Row | null = null
      const need = (field: keyof Row, label: string, ok: boolean) => {
        if (!ok) {
          messages.push(`${label}必填`)
          if (!firstField) firstField = field
        }
      }
      need('species', '品名', Boolean(row.species.trim()))
      need('thickness', '厚', toNumber(row.thickness) > 0)
      need('width', '宽', toNumber(row.width) > 0)
      need('length', '长', toNumber(row.length) > 0)
      need('pieces', '片数', toNumber(row.pieces) > 0)
      need('bundles', '件数', Number.isInteger(toNumber(row.bundles)) && toNumber(row.bundles) > 0)
      need('unitPrice', '单价', toNumber(row.unitPrice) > 0)

      const labels = parseLabels(row.baleLabel)
      /* 老版规则：件数 N、包号 M 个，M 不等于 N 直接拦（服务端也会 400） */
      if (labels.length > 0 && labels.length !== toNumber(row.bundles)) {
        messages.push(
          `件数填了 ${toNumber(row.bundles)} 件，但填了 ${labels.length} 个包号，请改成一致`,
        )
        if (!firstField) firstField = 'baleLabel'
      }
      labels.forEach((label) => {
        if (seen.has(label)) {
          messages.push(`包号 ${label} 这一张单里重复了`)
          if (!firstField) firstField = 'baleLabel'
        }
        seen.add(label)
      })
      if (messages.length) errors.push({ key: row.key, messages, firstField })
    })

    let form = ''
    if (!supplier.trim()) form = '供应商不能为空'
    else if (!blNo.trim()) form = '提单号必填，一票货一个号'
    else if (!warehouse.trim()) form = '仓库不能为空'
    else if (errors.length) form = `明细有 ${errors.length} 行填写有误`
    return { errors, form }
  }

  const scrollToRow = (row: RowError) => {
    const wrap = document.querySelector<HTMLElement>(`[data-m-row="${row.key}"]`)
    wrap?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    if (row.firstField) {
      window.setTimeout(() => {
        wrap?.querySelector<HTMLInputElement>(`input[data-field="${row.firstField}"]`)?.focus()
      }, 320)
    }
  }

  /** 包号全局唯一预检（服务端还会兜一次） */
  const checkLabelsFree = async (): Promise<string[]> => {
    const all = rows.flatMap((row) => parseLabels(row.baleLabel))
    const hits: string[] = []
    for (const label of all) {
      try {
        const found = await fetchBales({ keyword: label, limit: 1 })
        if (found.rows.some((bale) => bale.bale_no === label)) hits.push(label)
      } catch {
        /* 查不动就不拦，交给后端 */
      }
    }
    return hits
  }

  const handleSave = async (continueAfter = false) => {
    const { errors, form } = validate()
    setRowErrors(Object.fromEntries(errors.map((e) => [e.key, e.messages])))
    setFormError(form)
    if (form) {
      setToast({ id: `v-${Date.now()}`, message: form })
      if (errors.length) scrollToRow(errors[0])
      else {
        supplierRef.current?.focus()
        supplierRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
      return
    }
    const dup = await checkLabelsFree()
    if (dup.length) {
      const message = `包号 ${dup.join('、')} 已经存在，请换一个`
      setToast({ id: `dup-${Date.now()}`, message })
      setFormError(message)
      return
    }

    const items: InboundItemPayload[] = rows.map((row) => ({
      /* 品牌 / 等级都照用户填的传：等级参与库存归组（品名+等级+尺寸），
         写死空字符串会让手机录的货和电脑录的货在库存页裂成两行 */
      brand: row.brand.trim(),
      species: row.species.trim(),
      grade: row.grade.trim(),
      thickness: toNumber(row.thickness),
      width: toNumber(row.width),
      length: row.length.trim(),
      pieces: row.pieces.trim(),
      /* 件数照用户填的传：包号留空时由后端自动编号 N 个包 */
      bundles: toNumber(row.bundles),
      unit_price: toNumber(row.unitPrice),
      bale_labels: parseLabels(row.baleLabel),
    }))

    setSaving(true)
    try {
      const result = await createInbound({
        supplier: supplier.trim(),
        order_date: orderDate,
        warehouse: warehouse.trim(),
        operator: operator.trim(),
        bl_no: blNo.trim(),
        contract_no: contractNo.trim(),
        remark: remark.trim(),
        items,
      })
      if (continueAfter) {
        setRows([emptyRow()])
        setRowErrors({})
        setRemark('')
        setToast({
          id: `ok-${Date.now()}`,
          message: `已保存入库单 ${result.order_no}，可以接着录下一张`,
        })
      } else {
        navigate('/inbound', { replace: true })
      }
    } catch (err) {
      setToast({ id: `e-${Date.now()}`, message: err instanceof Error ? err.message : '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="m-stack" style={{ paddingBottom: 56 }}>
      <MobileTopbarActions>
        <MobileTopbarButton
          label="选合同"
          onClick={() => {
            setContractKeyword('')
            setContractOpen(true)
          }}
        />
      </MobileTopbarActions>

      {/* 选方式：页面内两个大按钮（不是全屏弹层 —— 顶栏返回键要随时能点） */}
      {methodOpen || !method ? (
        <MobileCard title="这批货怎么录？" className="m-method-card">
          <button
            type="button"
            className="m-method-option"
            onClick={() => {
              setMethod('contract')
              setMethodOpen(false)
              setContractKeyword('')
              setContractOpen(true)
            }}
          >
            <span className="m-item-main">
              <span className="m-item-title">按采购合同入库</span>
              <span className="m-item-sub">从合同带出供应商和合同号</span>
            </span>
            <span className="m-item-trail">›</span>
          </button>
          <button
            type="button"
            className="m-method-option"
            onClick={() => {
              setMethod('direct')
              setMethodOpen(false)
            }}
          >
            <span className="m-item-main">
              <span className="m-item-title">按提单直接入库</span>
              <span className="m-item-sub">散货 / 没挂合同的，直接填提单号</span>
            </span>
            <span className="m-item-trail">›</span>
          </button>
        </MobileCard>
      ) : (
        <div className="m-method-picked">
          <span>
            本次录入：<b>{method === 'contract' ? '按采购合同入库' : '按提单直接入库'}</b>
          </span>
          <button type="button" onClick={() => setMethodOpen(true)}>
            换方式
          </button>
        </div>
      )}

      <MobileCard title="基本信息">
        {formError && !Object.keys(rowErrors).length ? (
          <p style={{ marginBottom: 8, fontSize: 'var(--t-13)', color: 'var(--danger)' }}>
            {formError}
          </p>
        ) : null}
        <label className="m-field">
          <span className="m-field-label">供应商 *</span>
          <input
            ref={supplierRef}
            className="m-input"
            value={supplier}
            placeholder="谁供的货"
            onChange={(event) => setSupplier(event.target.value)}
          />
        </label>
        <label className="m-field">
          <span className="m-field-label">入库日期</span>
          <input
            className="m-input"
            type="date"
            value={orderDate}
            onChange={(event) => setOrderDate(event.target.value)}
          />
        </label>
        <MobileInput label="提单号 *" value={blNo} placeholder="例如：BL-2026-0001" onChange={setBlNo} />
        <MobileInput
          label="合同号"
          value={contractNo}
          placeholder="可从合同里选，也可手填"
          onChange={setContractNo}
        />
        <MobileInput label="仓库 *" value={warehouse} placeholder="例如：一号仓" onChange={setWarehouse} />
        <MobileInput label="操作员" value={operator} placeholder="选填" onChange={setOperator} />
        <MobileInput label="备注" value={remark} placeholder="选填" onChange={setRemark} />
      </MobileCard>

      <MobileCard title="明细" hint={`${rows.length} 行`}>
        {rows.length === 0 ? (
          <MobileEmpty text="还没有明细，点下面「+ 加一行」" />
        ) : (
          <div>
            {rows.map((row, index) => (
              <div
                className="m-line"
                key={row.key}
                data-m-row={row.key}
                style={{ scrollMarginTop: 56 }}
              >
                <span className="m-line-title">
                  第 {index + 1} 行
                  {rowErrors[row.key] ? (
                    <span className="m-line-sub" style={{ color: 'var(--danger)' }}>
                      {rowErrors[row.key][0]}
                    </span>
                  ) : null}
                </span>
                <div className="m-line-grid m-line-grid-4">
                  <label className="m-line-field">
                    <span className="m-line-label">包号</span>
                    <input
                      className="m-line-input"
                      data-field="baleLabel"
                      style={rowErrors[row.key]?.some((m) => m.includes('包号')) ? { boxShadow: '0 0 0 1px var(--danger)' } : undefined}
                      value={row.baleLabel}
                      placeholder="留空自动编"
                      onChange={(event) => updateRow(row.key, 'baleLabel', event.target.value)}
                    />
                  </label>
                  <label className="m-line-field">
                    <span className="m-line-label">厚</span>
                    <input
                      className="m-line-input"
                      data-field="thickness"
                      inputMode="decimal"
                      style={rowErrors[row.key]?.some((m) => m.startsWith('厚')) ? { boxShadow: '0 0 0 1px var(--danger)' } : undefined}
                      value={row.thickness}
                      onChange={(event) => updateRow(row.key, 'thickness', event.target.value)}
                    />
                  </label>
                  <label className="m-line-field">
                    <span className="m-line-label">宽</span>
                    <input
                      className="m-line-input"
                      data-field="width"
                      inputMode="decimal"
                      value={row.width}
                      onChange={(event) => updateRow(row.key, 'width', event.target.value)}
                    />
                  </label>
                  <label className="m-line-field">
                    <span className="m-line-label">长</span>
                    <input
                      className="m-line-input"
                      data-field="length"
                      inputMode="decimal"
                      value={row.length}
                      onChange={(event) => updateRow(row.key, 'length', event.target.value)}
                    />
                  </label>
                </div>
                {/* 第 2 行：品名独占（放得下「樟子松（进口）」这类长名） */}
                <div className="m-line-grid m-line-grid-1" style={{ marginTop: 8 }}>
                  <label className="m-line-field">
                    <span className="m-line-label">品名</span>
                    <input
                      className="m-line-input"
                      data-field="species"
                      style={rowErrors[row.key]?.some((m) => m.startsWith('品名')) ? { boxShadow: '0 0 0 1px var(--danger)' } : undefined}
                      value={row.species}
                      placeholder="樟子松"
                      onChange={(event) => updateRow(row.key, 'species', event.target.value)}
                    />
                  </label>
                </div>
                {/* 第 3 行：品牌 + 等级 */}
                <div className="m-line-grid m-line-grid-2" style={{ marginTop: 8 }}>
                  <label className="m-line-field">
                    <span className="m-line-label">品牌</span>
                    <input
                      className="m-line-input"
                      data-field="brand"
                      value={row.brand}
                      placeholder="选填"
                      onChange={(event) => updateRow(row.key, 'brand', event.target.value)}
                    />
                  </label>
                  <label className="m-line-field">
                    <span className="m-line-label">等级</span>
                    <input
                      className="m-line-input"
                      data-field="grade"
                      value={row.grade}
                      placeholder="选填，例：PR"
                      onChange={(event) => updateRow(row.key, 'grade', event.target.value)}
                    />
                  </label>
                </div>
                {/* 第 4 行：片数 + 件数 + 单价 */}
                <div className="m-line-grid m-line-grid-3" style={{ marginTop: 8 }}>
                  <label className="m-line-field">
                    <span className="m-line-label">片数</span>
                    <input
                      className="m-line-input"
                      data-field="pieces"
                      inputMode="numeric"
                      value={row.pieces}
                      onChange={(event) => updateRow(row.key, 'pieces', event.target.value)}
                    />
                  </label>
                  <label className="m-line-field">
                    <span className="m-line-label">件数</span>
                    <input
                      className="m-line-input"
                      data-field="bundles"
                      inputMode="numeric"
                      style={rowErrors[row.key]?.some((m) => m.startsWith('件数')) ? { boxShadow: '0 0 0 1px var(--danger)' } : undefined}
                      value={row.bundles}
                      placeholder="留空自动编"
                      onChange={(event) => updateRow(row.key, 'bundles', event.target.value)}
                    />
                  </label>
                  <label className="m-line-field">
                    <span className="m-line-label">单价</span>
                    <input
                      className="m-line-input"
                      data-field="unitPrice"
                      inputMode="decimal"
                      value={row.unitPrice}
                      onChange={(event) => updateRow(row.key, 'unitPrice', event.target.value)}
                    />
                  </label>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  {index > 0 ? (
                    <button
                      type="button"
                      className="m-btn m-btn-ghost m-btn-sm"
                      onClick={() => copyPrev(index)}
                    >
                      复制上一行
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="m-icon-btn m-icon-btn-sm"
                    aria-label="移除这一行"
                    onClick={() => removeRow(row.key)}
                  >
                    ✕
                  </button>
                  {/* 本行立方（自动算，只显示）+ 件数提示 */}
                  <span className="m-line-total">
                    {(
                      (toNumber(row.thickness) *
                        toNumber(row.width) *
                        toNumber(row.length) *
                        toNumber(row.pieces)) /
                      1_000_000
                    ).toFixed(4)}{' '}
                    m³
                  </span>
                  <span style={{ alignSelf: 'center', fontSize: 'var(--t-13)', color: 'var(--ink-3)' }}>
                    {parseLabels(row.baleLabel).length > 0
                      ? `包号 ${parseLabels(row.baleLabel).length} 个`
                      : `自动编 ${toNumber(row.bundles) || 1} 个包号`}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          className="m-btn m-btn-ghost"
          style={{ width: '100%', marginTop: 12 }}
          onClick={addRow}
        >
          ＋ 加一行
        </button>
        <p style={{ marginTop: 8, fontSize: 'var(--t-13)', color: 'var(--ink-3)' }}>
          合计 {totalCubic.toFixed(4)} m³ · 件数按包号个数自动算
        </p>
      </MobileCard>

      <div className="m-actionbar m-actionbar-3">
        <button
          type="button"
          className="m-btn m-btn-primary"
          disabled={saving}
          onClick={() => {
            tapMedium()
            void handleSave(false)
          }}
        >
          {saving ? '保存中…' : '保存'}
        </button>
        <button
          type="button"
          className="m-btn m-btn-ghost"
          disabled={saving}
          onClick={() => {
            tapMedium()
            void handleSave(true)
          }}
        >
          保存并继续
        </button>
        <button
          type="button"
          className="m-btn m-btn-ghost"
          onClick={() => goBack(navigate, '/inbound')}
        >
          取消
        </button>
      </div>

      {/* 选合同 */}
      <MobileSheet open={contractOpen} title="选采购合同" onClose={() => setContractOpen(false)}>
        <MobileSearchBar value={contractKeyword} placeholder="合同号 / 客户 / 名称" onChange={setContractKeyword} />
        <div style={{ marginTop: 12, maxHeight: '48vh', overflowY: 'auto' }}>
          {contractLoading ? (
            <MobileSkeleton cards={2} />
          ) : contracts.length === 0 ? (
            <MobileEmpty text="没有匹配的合同" />
          ) : (
            contracts.map((item) => (
              <button
                type="button"
                className="m-row-check"
                key={item.id}
                onClick={() => {
                  setSupplier(item.partner || '')
                  setContractNo(item.contract_no)
                  setContractOpen(false)
                  setToast({ id: `c-${Date.now()}`, message: `已选合同 ${item.contract_no}（${item.partner || '—'}）` })
                }}
              >
                <span className="m-item-main">
                  <span className="m-item-title">{item.contract_no}</span>
                  <span className="m-item-sub">{item.partner || '—'}</span>
                </span>
                <span className="m-item-trail">选它</span>
              </button>
            ))
          )}
        </div>
      </MobileSheet>

      <MobileToastHost items={[toast]} />
    </div>
  )
}
