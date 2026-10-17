/**
 * 出库表单 · 手机版（第 4 步）。
 *
 * 明细来自「选择码单 / 扫一扫」，规格只读、件数单价可填；
 * 数据与交互沿用现有接口（fetchBales / scanOutboundBale / createOutbound）。
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  createOutbound,
  fetchBaleDetail,
  fetchBales,
  scanOutboundBale,
  type BaleRow,
  type InboundItemPayload,
} from '../api'
import { todayISO, toNumber, formatCubic } from '../utils/num'
import { tapHeavy, tapLight, tapMedium } from '../utils/haptics'
import { useKeyboardScroll } from '../hooks/useKeyboardScroll'
import { goBack } from './nav'
import SuccessToast from '../components/SuccessToast'
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

const Scanner = lazy(() => import('../components/Scanner'))

type Row = {
  key: number
  baleId: number
  baleNo: string
  spec: string
  cubic: number
  pieces: string
  unitPrice: string
}

const toRow = (bale: {
  /* 扫码接口给的是 bale_id，码单列表给的是 id —— 两种都认 */
  id?: number
  bale_id?: number
  bale_no: string
  species: string
  grade: string
  thickness: number
  width: number
  length: number
  pieces: number
  cubic: number
  brand?: string
}): Row => ({
  key: bale.id ?? bale.bale_id ?? 0,
  baleId: bale.id ?? bale.bale_id ?? 0,
  baleNo: bale.bale_no,
  /* 品牌 / 等级从码单带出来，只读展示（出库不改货的归属） */
  spec: `${bale.species} ${bale.grade || ''} ${bale.brand || ''} ${bale.thickness}×${bale.width}×${bale.length}`
    .replace(/\s+/g, ' ')
    .trim(),
  cubic: bale.cubic,
  pieces: String(bale.pieces),
  unitPrice: '',
})

export default function OutboundFormMobile() {
  const navigate = useNavigate()
  useKeyboardScroll(true)
  const [customer, setCustomer] = useState('')
  const [orderDate, setOrderDate] = useState(todayISO())
  const [warehouse, setWarehouse] = useState('')
  const [remark, setRemark] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<MobileToastItem | null>(null)
  const [success, setSuccess] = useState<{
    title: string
    subtitle: string
    toList: boolean
  } | null>(null)
  useAutoDismiss(toast, () => setToast(null))
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerKeyword, setPickerKeyword] = useState('')
  const [pickerRows, setPickerRows] = useState<BaleRow[]>([])
  const [pickerPicked, setPickerPicked] = useState<number[]>([])
  const [pickerLoading, setPickerLoading] = useState(false)
  const [scannerOpen, setScannerOpen] = useState(false)
  const customerRef = useRef<HTMLInputElement | null>(null)

  const loadPicker = useCallback(async (keyword: string) => {
    setPickerLoading(true)
    try {
      const result = await fetchBales({ status: 'in_stock', keyword, limit: 50 })
      setPickerRows(result.rows)
    } catch (err) {
      setToast({ id: `e-${Date.now()}`, message: err instanceof Error ? err.message : '加载码单失败' })
    } finally {
      setPickerLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!pickerOpen) return
    const timer = window.setTimeout(() => void loadPicker(pickerKeyword.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [pickerOpen, pickerKeyword, loadPicker])

  const totalCubic = useMemo(() => rows.reduce((sum, row) => sum + row.cubic, 0), [rows])

  const addBales = (bales: Row[]) => {
    setRows((prev) => {
      const existing = new Set(prev.map((row) => row.baleId))
      return [...prev, ...bales.filter((row) => !existing.has(row.baleId))]
    })
  }

  /**
   * 加进来的包要带上成本价：服务端校验「每行单价必填且 > 0」，
   * 空着的话保存会被 400 拦回来（验证时踩到过）。口径和桌面端一致 ——
   * 按这一包各行立方加权平均。
   */
  const addBalesWithPrice = async (ids: number[], bales: Row[]) => {
    const withPrice = await Promise.all(
      bales.map(async (row) => {
        try {
          const detail = await fetchBaleDetail(ids[bales.indexOf(row)] ?? row.baleId)
          const sumCubic = detail.items.reduce((sum, item) => sum + item.cubic, 0)
          if (!(sumCubic > 0)) return row
          const price =
            detail.items.reduce((sum, item) => sum + (item.unit_price ?? 0) * item.cubic, 0) /
            sumCubic
          return price > 0 ? { ...row, unitPrice: String(Math.round(price * 100) / 100) } : row
        } catch {
          return row
        }
      }),
    )
    addBales(withPrice)
  }

  const handleScan = async (code: string) => {
    try {
      const bale = await scanOutboundBale(code)
      await addBalesWithPrice([bale.bale_id], [toRow(bale)])
      setToast({ id: `s-${Date.now()}`, message: `已加入：${bale.bale_no}` })
    } catch (err) {
      setToast({ id: `e-${Date.now()}`, message: err instanceof Error ? err.message : '这一包扫不进来' })
    }
  }

  const buildPayload = () => {
    const items: InboundItemPayload[] = rows.map((row) => ({
      bale_id: row.baleId,
      bale_no: row.baleNo,
      species: '',
      grade: '',
      thickness: 0,
      width: 0,
      length: 0,
      pieces: toNumber(row.pieces),
      bundles: 1,
      unit_price: toNumber(row.unitPrice),
    }))
    return {
      customer: customer.trim(),
      order_date: orderDate,
      warehouse: warehouse.trim(),
      remark: remark.trim(),
      bale_ids: rows.map((row) => row.baleId),
      items,
    }
  }

  const handleSave = async (continueAfter = false) => {
    if (!customer.trim()) {
      setToast({ id: `v-${Date.now()}`, message: '客户不能为空' })
      customerRef.current?.focus()
      customerRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      return
    }
    if (!warehouse.trim()) {
      setToast({ id: `v-${Date.now()}`, message: '仓库不能为空' })
      return
    }
    if (rows.length === 0) {
      setToast({ id: `v-${Date.now()}`, message: '至少选一包货' })
      return
    }
    setSaving(true)
    try {
      const result = await createOutbound(buildPayload())
      if (continueAfter) {
        setRows([])
        setRemark('')
        setSuccess({
          title: '已出库',
          subtitle: `出库单 ${result.order_no} 保存成功`,
          toList: false,
        })
      } else {
        setSuccess({
          title: '已出库',
          subtitle: `出库单 ${result.order_no} 保存成功`,
          toList: true,
        })
      }
    } catch (err) {
      setToast({ id: `e-${Date.now()}`, message: err instanceof Error ? err.message : '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  // paddingBottom 56 = 底部操作栏高度；Tab 栏那 72px 由外壳 .m-body 自己的 padding 兜着
  return (
    <div className="m-stack" style={{ paddingBottom: 56 }}>
      <MobileTopbarActions>
        <MobileTopbarButton label="扫一扫" onClick={() => setScannerOpen(true)} />
      </MobileTopbarActions>

      <MobileCard title="基本信息">
        <MobileInput
          label="客户 *"
          value={customer}
          placeholder="出给谁"
          onChange={setCustomer}
        />
        <label className="m-field">
          <span className="m-field-label">出库日期</span>
          <input
            className="m-input"
            type="date"
            value={orderDate}
            onChange={(event) => setOrderDate(event.target.value)}
          />
        </label>
        <MobileInput label="仓库 *" value={warehouse} placeholder="例如：一号仓" onChange={setWarehouse} />
        <MobileInput label="备注" value={remark} placeholder="选填" onChange={setRemark} />
      </MobileCard>

      <MobileCard title="明细" hint={`${rows.length} 包 · ${formatCubic(totalCubic)} m³`}>
        <div className="m-sheet-actions" style={{ marginTop: 0, marginBottom: 12 }}>
          <button
            type="button"
            className="m-btn m-btn-primary"
            onClick={() => {
              tapLight()
              setPickerPicked([])
              setPickerOpen(true)
            }}
          >
            选择码单
          </button>
          <button
            type="button"
            className="m-btn m-btn-ghost"
            onClick={() => {
              tapLight()
              setScannerOpen(true)
            }}
          >
            扫一扫
          </button>
        </div>

        {rows.length === 0 ? (
          <MobileEmpty text="还没选货：点上面的「选择码单」或「扫一扫」" />
        ) : (
          <div>
            {rows.map((row) => (
              <div className="m-line" key={row.key}>
                <span className="m-line-title">
                  {row.baleNo}
                  <span className="m-line-sub">{row.spec}</span>
                </span>
                {/* 片数 / 立方 锁定 + 单价可填 + 移除：四格 */}
                <div className="m-line-grid m-line-grid-4">
                  {/*
                    P0：从码单带出来的片数**锁死**。整包出库，件数=包内件数、片数=包内片数，
                    能不能对得上账全靠这两个数不能被改；要改只能去「改包」或撤销出库。
                    pointer-events:none 让点击连聚焦都进不去。
                  */}
                  <label className="m-line-field">
                    <span className="m-line-label">片数（锁定）</span>
                    <input
                      className="m-line-input is-locked"
                      value={row.pieces}
                      readOnly
                      tabIndex={-1}
                      aria-readonly="true"
                    />
                  </label>
                  <label className="m-line-field">
                    <span className="m-line-label">立方（锁定）</span>
                    <input
                      className="m-line-input is-locked"
                      value={row.cubic.toFixed(4)}
                      readOnly
                      tabIndex={-1}
                      aria-readonly="true"
                    />
                  </label>
                  <label className="m-line-field">
                    <span className="m-line-label">单价（元）</span>
                    <input
                      className="m-line-input"
                      inputMode="decimal"
                      value={row.unitPrice}
                      onChange={(event) =>
                        setRows((prev) =>
                          prev.map((item) =>
                            item.key === row.key ? { ...item, unitPrice: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="m-icon-btn"
                    aria-label="移除这一行"
                    onClick={() => {
                      tapHeavy()
                      setRows((prev) => prev.filter((item) => item.key !== row.key))
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
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
          onClick={() => goBack(navigate, '/outbound')}
        >
          取消
        </button>
      </div>

      <MobileSheet open={pickerOpen} title="选择码单" onClose={() => setPickerOpen(false)}>
        <MobileSearchBar value={pickerKeyword} placeholder="包号 / 条码 / 规格" onChange={setPickerKeyword} />
        <p className="m-picker-count">
          共 {pickerRows.length} 包在库{pickerPicked.length > 0 ? ` · 已选 ${pickerPicked.length}` : ''}
        </p>
        <div style={{ marginTop: 4, maxHeight: '44vh', overflowY: 'auto' }}>
          {pickerLoading ? (
            <MobileSkeleton cards={2} />
          ) : pickerRows.length === 0 ? (
            <MobileEmpty text="没有在库的码单" />
          ) : (
            <div className="m-rows">
              {pickerRows.map((bale) => {
                const on = pickerPicked.includes(bale.id)
                return (
                  <button
                    type="button"
                    className={on ? 'm-row-check is-on' : 'm-row-check'}
                    key={bale.id}
                    onClick={() =>
                      setPickerPicked((prev) =>
                        on ? prev.filter((id) => id !== bale.id) : [...prev, bale.id],
                      )
                    }
                  >
                    <span className="m-check-box" aria-hidden="true">
                      ✓
                    </span>
                    <span className="m-item-main">
                      <span className="m-item-title">
                        {/* 包号可以是空的（入库时留空自动编号的包），那就显示条码号 */}
                        {bale.bale_no || bale.barcode} · 提单 {bale.bl_no || '—'}
                      </span>
                      <span className="m-item-sub">
                        {bale.species} {bale.grade || ''} {bale.thickness}×{bale.width}×{bale.length}
                        {bale.contract_no ? ` · 合同 ${bale.contract_no}` : ''}
                      </span>
                    </span>
                    <span className="m-item-trail is-num">{formatCubic(bale.cubic)} m³</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
        <div className="m-sheet-actions">
          <button
            type="button"
            className="m-btn m-btn-primary"
            disabled={pickerPicked.length === 0}
            onClick={() => {
              const chosen = pickerRows.filter((bale) => pickerPicked.includes(bale.id))
              void addBalesWithPrice(
                chosen.map((bale) => bale.id),
                chosen.map((bale) => toRow(bale)),
              )
              setPickerOpen(false)
              setPickerPicked([])
            }}
          >
            加入本次出库（{pickerPicked.length}）
          </button>
          <button type="button" className="m-btn m-btn-ghost" onClick={() => setPickerOpen(false)}>
            取消
          </button>
        </div>
      </MobileSheet>

      {scannerOpen ? (
        <Suspense fallback={null}>
          <Scanner open={scannerOpen} onClose={() => setScannerOpen(false)} onScan={handleScan} />
        </Suspense>
      ) : null}

      <MobileToastHost items={[toast]} />
      <SuccessToast
        open={Boolean(success)}
        title={success?.title ?? ''}
        subtitle={success?.subtitle ?? ''}
        onDone={() => {
          const goList = Boolean(success?.toList)
          setSuccess(null)
          if (goList) navigate('/outbound', { replace: true })
        }}
      />
    </div>
  )
}
