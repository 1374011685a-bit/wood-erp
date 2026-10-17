/**
 * 入库列表 · 手机版（第 2 步）。
 *
 * 数据与交互**完全沿用现有接口**（fetchInboundList / fetchInboundDetail /
 * deleteInbound / restoreRecycleOrder），一行业务逻辑都没改；只是换了一套 UI。
 * 桌面端永远不会渲染这个文件（由 App.tsx 的 InboundSwitch 按视口分流）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  deleteInbound,
  fetchInboundDetail,
  fetchInboundList,
  restoreRecycleOrder,
  type InboundDetail,
  type InboundListItem,
} from '../api'
import { formatCubic, formatAmount } from '../utils/num'
import { seesMoney } from '../permissions'
import { useRole } from '../hooks/useRole'
import { tapHeavy, tapLight, tapMedium } from '../utils/haptics'
import {
  MobileEmpty,
  MobileList,
  MobileListItem,
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

const PAGE_SIZE = 20
const EMPTY_FILTERS = { date_from: '', date_to: '', supplier: '' }

export default function InboundListMobile() {
  const navigate = useNavigate()
  const money = seesMoney(useRole())
  const [keyword, setKeyword] = useState('')
  const [debounced, setDebounced] = useState('')
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [draft, setDraft] = useState(EMPTY_FILTERS)
  const [filterOpen, setFilterOpen] = useState(false)
  const [rows, setRows] = useState<InboundListItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [detail, setDetail] = useState<InboundDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<InboundListItem | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [toast, setToast] = useState<MobileToastItem | null>(null)
  useAutoDismiss(toast, () => setToast(null))

  /** 搜索防抖 300ms */
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(keyword.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [keyword])

  const query = useMemo(
    () => ({ ...filters, order_no: debounced }),
    [filters, debounced],
  )
  const queryRef = useRef(query)
  queryRef.current = query

  const load = useCallback(async (offset: number, append: boolean) => {
    if (append) setLoadingMore(true)
    else setLoading(true)
    try {
      const result = await fetchInboundList({
        ...queryRef.current,
        limit: PAGE_SIZE,
        offset,
      })
      setRows((prev) => (append ? [...prev, ...result.rows] : result.rows))
      setTotal(result.total)
    } catch (err) {
      setToast({ id: `err-${Date.now()}`, message: err instanceof Error ? err.message : '加载失败' })
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [])

  useEffect(() => {
    void load(0, false)
  }, [load, query])

  const openDetail = async (id: number) => {
    tapLight()
    setDetailLoading(true)
    try {
      setDetail(await fetchInboundDetail(id))
    } catch (err) {
      setToast({ id: `err-${Date.now()}`, message: err instanceof Error ? err.message : '打开详情失败' })
    } finally {
      setDetailLoading(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    const target = deleteTarget
    try {
      await deleteInbound(target.id)
      setDeleteTarget(null)
      setDetail(null)
      setRows((prev) => prev.filter((row) => row.id !== target.id))
      setTotal((prev) => Math.max(0, prev - 1))
      setToast({
        id: `del-${target.id}`,
        message: `已移入回收站：${target.order_no}`,
        actionLabel: '撤销',
        onAction: () => {
          void restoreRecycleOrder('in', target.id).then(() => {
            setToast({ id: `undo-${Date.now()}`, message: '已恢复' })
            void load(0, false)
          })
        },
      })
    } catch (err) {
      setToast({ id: `err-${Date.now()}`, message: err instanceof Error ? err.message : '删除失败' })
    } finally {
      setDeleting(false)
    }
  }

  const appliedCount = (filters.date_from || filters.date_to ? 1 : 0) + (filters.supplier ? 1 : 0)

  return (
    <div className="m-stack">
      <MobileTopbarActions>
        <MobileTopbarButton label="筛选" badge={appliedCount} onClick={() => {
          setDraft(filters)
          setFilterOpen(true)
        }} />
        <MobileTopbarButton label="＋" onClick={() => navigate('/inbound/new')} />
      </MobileTopbarActions>

      <MobileSearchBar value={keyword} placeholder="搜单号" onChange={setKeyword} />

      {loading ? (
        <MobileSkeleton cards={3} />
      ) : rows.length === 0 ? (
        <MobileEmpty
          text={appliedCount || debounced ? '没有符合条件的入库单' : '还没有入库单'}
          actionLabel="去录入库"
          onAction={() => navigate('/inbound/new')}
        />
      ) : (
        <>
          <MobileList>
            {rows.map((row) => (
              <MobileListItem
                key={row.id}
                dense
                title={row.order_no}
                sub={`${row.supplier || '—'} · ${formatCubic(row.total_cubic)} m³ · ${row.bale_total} 包`}
                trail={
                  <span className="m-list-trail-stack">
                    <span>{row.order_date?.slice(5) ?? ''}</span>
                    <MobileStatusTag tone="success">已入库</MobileStatusTag>
                  </span>
                }
                onClick={() => void openDetail(row.id)}
              />
            ))}
          </MobileList>
          {rows.length < total ? (
            <button
              type="button"
              className="m-loadmore"
              disabled={loadingMore}
              onClick={() => void load(rows.length, true)}
            >
              {loadingMore ? '加载中…' : `加载更多（还有 ${total - rows.length} 张）`}
            </button>
          ) : (
            <p style={{ textAlign: 'center', color: 'var(--ink-3)', fontSize: 'var(--t-13)' }}>
              共 {total} 张
            </p>
          )}
        </>
      )}

      {/* 详情 */}
      <MobileSheet
        open={Boolean(detail) || detailLoading}
        title={detail ? detail.order_no : '加载中…'}
        titleExtra={
          detail ? (
            <MobileStatusTag tone="success" large>
              已入库
            </MobileStatusTag>
          ) : undefined
        }
        onClose={() => setDetail(null)}
      >
        {detail ? (
          <>
            <div className="m-rows">
              {[
                ['单号', detail.order_no],
                ['供应商', detail.supplier || '—'],
                ['入库日期', detail.order_date || '—'],
                ['提单号', detail.bl_no || '—'],
                [
                  '柜号',
                  [...new Set(detail.bales.map((bale) => bale.box_no).filter(Boolean))]
                    .join('、') || '—',
                ],
                ['合同号', detail.contract_no || '—'],
                ['仓库', detail.warehouse || '—'],
                ['操作员', detail.operator || '—'],
                ['车号', detail.vehicle_no || '—'],
                ['创建时间', detail.created_at || '—'],
                ['备注', detail.remark || '—'],
                ['总包数', `${detail.bales.length} 包`, true],
                ['总立方', `${formatCubic(detail.total_cubic)} m³`, true],
                ...(money ? [['总金额', `${formatAmount(detail.total_amount)} 元`, true]] : []),
              ].map(([label, value, isNum]) => (
                <div className="m-row" key={label as string}>
                  <span className="m-row-label">{label as string}</span>
                  <span className={isNum ? 'm-row-value is-num' : 'm-row-value'}>{value as string}</span>
                </div>
              ))}
            </div>

            <h3 className="m-detail-title">入库明细</h3>
            <div className="m-outbound-detail-list">
              {detail.items.map((item) => {
                const itemBaleNos = item.bale_no
                  ? item.bale_no.split(/[、,，/\s]+/).filter(Boolean)
                  : (item.bale_labels ?? [])
                const relatedBales = detail.bales.filter((bale) =>
                  itemBaleNos.includes(bale.bale_no),
                )
                const baleNo =
                  itemBaleNos.join('、') || relatedBales.map((bale) => bale.bale_no).join('、')
                const barcode =
                  relatedBales.map((bale) => bale.barcode).filter(Boolean).join('、') || '—'
                return (
                  <div className="m-outbound-detail-card" key={item.id}>
                    <div className="m-outbound-detail-head">
                      <b>包号 {baleNo || '—'}</b>
                      <span>条码 {barcode}</span>
                    </div>
                    <p>品牌 {item.brand || '—'}</p>
                    <p>品名 {item.species || '—'} · 等级 {item.grade || '—'}</p>
                    <p>
                      规格 {item.thickness}×{item.width}×{item.length} · 片数 {item.pieces} ·{' '}
                      件数 {item.bundles} · 立方 {formatCubic(item.cubic)} m³
                    </p>
                    {money ? (
                      <p>
                        单价 {formatAmount(item.unit_price)} 元 · 金额{' '}
                        {formatAmount(item.amount)} 元
                      </p>
                    ) : null}
                  </div>
                )
              })}
            </div>

            <h3 className="m-detail-title">本单码单</h3>
            <div className="m-outbound-detail-list">
              {detail.bales.map((bale) => (
                <div className="m-outbound-detail-card" key={bale.id ?? bale.barcode}>
                  <div className="m-outbound-detail-head">
                    <b>包号 {bale.bale_no || '—'}</b>
                    <span>{bale.status === 'in_stock' ? '在库' : '已出库'}</span>
                  </div>
                  <p>条码 {bale.barcode || '—'} · 柜号 {bale.box_no || '—'}</p>
                  <p>
                    规格 {bale.thickness}×{bale.width}×{bale.length_text ?? bale.length} · 片数{' '}
                    {bale.pieces_text ?? bale.pieces} · 立方 {formatCubic(bale.cubic)} m³
                  </p>
                </div>
              ))}
            </div>
            <div className="m-sheet-actions">
              <button
                type="button"
                className="m-btn m-btn-danger"
                onClick={() => {
                  tapHeavy()
                  setDeleteTarget({
                    id: detail.id,
                    order_no: detail.order_no,
                  } as InboundListItem)
                }}
              >
                移入回收站
              </button>
              <button type="button" className="m-btn m-btn-ghost" onClick={() => setDetail(null)}>
                关闭
              </button>
            </div>
          </>
        ) : null}
      </MobileSheet>

      {/* 筛选 */}
      <MobileSheet open={filterOpen} title="筛选" onClose={() => setFilterOpen(false)}>
        <div className="m-filter-fields">
          <label className="m-field">
            <span className="m-field-label">起始日期</span>
            <input
              className="m-input"
              type="date"
              value={draft.date_from}
              onChange={(event) => setDraft((prev) => ({ ...prev, date_from: event.target.value }))}
            />
          </label>
          <label className="m-field">
            <span className="m-field-label">截止日期</span>
            <input
              className="m-input"
              type="date"
              value={draft.date_to}
              onChange={(event) => setDraft((prev) => ({ ...prev, date_to: event.target.value }))}
            />
          </label>
          <label className="m-field">
            <span className="m-field-label">供应商</span>
            <input
              className="m-input"
              value={draft.supplier}
              placeholder="供应商关键字"
              onChange={(event) => setDraft((prev) => ({ ...prev, supplier: event.target.value }))}
            />
          </label>
        </div>
        <div className="m-sheet-actions">
          <button
            type="button"
            className="m-btn m-btn-primary"
            onClick={() => {
              tapMedium()
              setFilters(draft)
              setFilterOpen(false)
            }}
          >
            应用
          </button>
          <button
            type="button"
            className="m-btn m-btn-ghost"
            onClick={() => {
              setDraft(EMPTY_FILTERS)
              setFilters(EMPTY_FILTERS)
              setFilterOpen(false)
            }}
          >
            清除
          </button>
        </div>
      </MobileSheet>

      {/* 删除二次确认 */}
      <MobileSheet
        open={Boolean(deleteTarget)}
        title="移入回收站？"
        onClose={() => setDeleteTarget(null)}
      >
        <p style={{ color: 'var(--ink-2)', fontSize: 'var(--t-15)' }}>
          {deleteTarget?.order_no} 会被移入回收站，库存同步回退，之后可以恢复。
        </p>
        <div className="m-sheet-actions">
          <button
            type="button"
            className="m-btn m-btn-danger"
            disabled={deleting}
            onClick={() => void confirmDelete()}
          >
            {deleting ? '处理中…' : '确认移入'}
          </button>
          <button type="button" className="m-btn m-btn-ghost" onClick={() => setDeleteTarget(null)}>
            取消
          </button>
        </div>
      </MobileSheet>

      <MobileToastHost items={[toast]} />
    </div>
  )
}
