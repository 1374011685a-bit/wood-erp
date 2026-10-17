/**
 * 出库列表 · 手机版（第 3 步）。做法与入库列表一致：
 * 数据与交互沿用现有接口，只换 UI。操作叫「撤销出库」（不是移入回收站）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
  deleteOutbound,
  fetchOutboundDetail,
  fetchOutboundList,
  restoreRecycleOrder,
  type OutboundDetail,
  type OutboundListItem,
} from '../api'
import { formatCubic, formatAmount } from '../utils/num'
import { seesMoney } from '../permissions'
import { useRole } from '../hooks/useRole'
import { readListCache, writeListCache } from '../utils/listCache'
import { tapHeavy, tapLight, tapMedium } from '../utils/haptics'
import {
  MobileEmpty,
  MobileList,
  MobileListItem,
  MobileSearchBar,
  MobileSheet,
  MobileSkeleton,
  MobileRefreshBar,
  MobileStatusTag,
  MobileToastHost,
  MobileTopbarActions,
  MobileTopbarButton,
  useAutoDismiss,
  type MobileToastItem,
} from './components'
import { useMobileNavigate } from './useMobileNavigate'
import { useMobileScrollMemory } from './useMobileScrollMemory'

const PAGE_SIZE = 20
const EMPTY_FILTERS = { date_from: '', date_to: '', customer: '' }

export default function OutboundListMobile() {
  const navigate = useMobileNavigate()
  const location = useLocation()
  const money = seesMoney(useRole())
  const [keyword, setKeyword] = useState('')
  const [debounced, setDebounced] = useState('')
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [draft, setDraft] = useState(EMPTY_FILTERS)
  const [filterOpen, setFilterOpen] = useState(false)
  const initialCacheKey = `m:outbound:${JSON.stringify({ ...EMPTY_FILTERS, order_no: '' })}`
  const initialCache = readListCache<{ rows: OutboundListItem[]; total: number }>(
    initialCacheKey,
  )
  const [rows, setRows] = useState<OutboundListItem[]>(initialCache?.rows ?? [])
  const [total, setTotal] = useState(initialCache?.total ?? 0)
  const [loading, setLoading] = useState(!initialCache)
  const [refreshing, setRefreshing] = useState(Boolean(initialCache))
  const [loadingMore, setLoadingMore] = useState(false)
  const [detail, setDetail] = useState<OutboundDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [undoTarget, setUndoTarget] = useState<OutboundListItem | null>(null)
  const [undoing, setUndoing] = useState(false)
  const [toast, setToast] = useState<MobileToastItem | null>(null)
  useAutoDismiss(toast, () => setToast(null))

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
  useMobileScrollMemory(`${location.pathname}${location.search}`, !loading)

  const load = useCallback(async (offset: number, append: boolean) => {
    const cacheKey = `m:outbound:${JSON.stringify(queryRef.current)}`
    if (append) {
      setLoadingMore(true)
    } else {
      const cached = readListCache<{ rows: OutboundListItem[]; total: number }>(cacheKey)
      if (cached) {
        setRows(cached.rows)
        setTotal(cached.total)
        setLoading(false)
        setRefreshing(true)
      } else {
        setLoading(true)
      }
    }
    try {
      const result = await fetchOutboundList({
        ...queryRef.current,
        limit: PAGE_SIZE,
        offset,
      })
      setRows((prev) => (append ? [...prev, ...result.rows] : result.rows))
      setTotal(result.total)
      if (!append) {
        writeListCache(cacheKey, { rows: result.rows, total: result.total })
      }
    } catch (err) {
      setToast({ id: `err-${Date.now()}`, message: err instanceof Error ? err.message : '加载失败' })
    } finally {
      setLoading(false)
      setLoadingMore(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load(0, false)
  }, [load, query])

  const openDetail = async (id: number) => {
    tapLight()
    setDetailLoading(true)
    try {
      setDetail(await fetchOutboundDetail(id))
    } catch (err) {
      setToast({ id: `err-${Date.now()}`, message: err instanceof Error ? err.message : '打开详情失败' })
    } finally {
      setDetailLoading(false)
    }
  }

  const confirmUndo = async () => {
    if (!undoTarget) return
    setUndoing(true)
    const target = undoTarget
    try {
      await deleteOutbound(target.id)
      setUndoTarget(null)
      setDetail(null)
      setRows((prev) => prev.filter((row) => row.id !== target.id))
      setTotal((prev) => Math.max(0, prev - 1))
      setToast({
        id: `undo-${target.id}`,
        message: `已撤销出库：${target.order_no}（库存已回退）`,
        actionLabel: '撤销',
        onAction: () => {
          void restoreRecycleOrder('out', target.id).then(() => {
            setToast({ id: `re-${Date.now()}`, message: '已恢复出库单' })
            void load(0, false)
          })
        },
      })
    } catch (err) {
      setToast({ id: `err-${Date.now()}`, message: err instanceof Error ? err.message : '撤销失败' })
    } finally {
      setUndoing(false)
    }
  }

  const appliedCount = (filters.date_from || filters.date_to ? 1 : 0) + (filters.customer ? 1 : 0)

  return (
    <div className="m-stack">
      <MobileTopbarActions>
        <MobileTopbarButton
          label="筛选"
          badge={appliedCount}
          onClick={() => {
            setDraft(filters)
            setFilterOpen(true)
          }}
        />
        <MobileTopbarButton label="＋" onClick={() => navigate('/outbound/new')} />
      </MobileTopbarActions>

      <MobileSearchBar value={keyword} placeholder="搜出库单号" onChange={setKeyword} />
      <MobileRefreshBar active={refreshing} />

      {loading ? (
        <MobileSkeleton cards={3} />
      ) : rows.length === 0 ? (
        <MobileEmpty
          text={appliedCount || debounced ? '没有符合条件的出库单' : '还没有出库单'}
          actionLabel="去出库"
          onAction={() => navigate('/outbound/new')}
        />
      ) : (
        <>
          <MobileList>
            {rows.map((row) => (
              <MobileListItem
                key={row.id}
                dense
                title={row.order_no}
                sub={`${row.customer || '—'} · ${row.warehouse || '—'}${row.operator ? ` · ${row.operator}` : ''} · ${formatCubic(row.total_cubic)} m³ · ${row.item_count} 行`}
                trail={
                  <span className="m-list-trail-stack">
                    <span>{row.order_date?.slice(5) ?? ''}</span>
                    <MobileStatusTag tone="info">已出库</MobileStatusTag>
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

      <MobileSheet
        open={Boolean(detail) || detailLoading}
        title={detail ? detail.order_no : '加载中…'}
        titleExtra={
          detail ? (
            <MobileStatusTag tone="info" large>
              已出库
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
                ['客户', detail.customer || '—'],
                ['出库日期', detail.order_date || '—'],
                ['仓库', detail.warehouse || '—'],
                ['操作员', detail.operator || '—'],
                ['车号', detail.vehicle_no || '—'],
                ['创建时间', detail.created_at || '—'],
                ['备注', detail.remark || '—'],
                ['码单数', `${detail.bales.length} 包`],
                ['明细行数', String(detail.items.length)],
                ['总立方', `${formatCubic(detail.total_cubic)} m³`, true],
                ...(money ? [['总金额', `${formatAmount(detail.total_amount)} 元`, true]] : []),
              ].map(([label, value, isNum]) => (
                <div className="m-row" key={label as string}>
                  <span className="m-row-label">{label as string}</span>
                  <span className={isNum ? 'm-row-value is-num' : 'm-row-value'}>
                    {value as string}
                  </span>
                </div>
              ))}
            </div>

            <h3 className="m-detail-title">商品明细</h3>
            <div className="m-outbound-detail-list">
              {detail.items.map((item) => {
                const baleNo =
                  item.bale_no || (Array.isArray(item.bale_labels) ? item.bale_labels.join('、') : '')
                const spec = `${item.thickness}×${item.width}×${item.length}`
                return (
                  <div className="m-outbound-detail-card" key={item.id}>
                    <div className="m-outbound-detail-head">
                      <b>包号 {baleNo || '—'}</b>
                      <span>条码 —</span>
                    </div>
                    <p>品牌 {item.brand || '—'}</p>
                    <p>品名 {item.species || '—'} · 等级 {item.grade || '—'}</p>
                    <p>
                      规格 {spec} · 片数 {item.pieces} · 件数 {item.bundles} · 立方{' '}
                      {formatCubic(item.cubic)} m³
                    </p>
                    {money ? (
                      <p>
                        单价 {formatAmount(item.unit_price)} 元 · 金额{' '}
                        {formatAmount(item.amount)} 元
                      </p>
                    ) : null}
                    <p>
                      当前库存 {formatCubic(item.stock_cubic ?? 0)} m³ /{' '}
                      {item.stock_bundles ?? 0} 件
                    </p>
                  </div>
                )
              })}
            </div>

            <h3 className="m-detail-title">本次发出的码单</h3>
            <div className="m-outbound-detail-list">
              {detail.bales.map((bale) => (
                <div className="m-outbound-detail-card" key={bale.barcode || bale.bale_no}>
                  <div className="m-outbound-detail-head">
                    <b>包号 {bale.bale_no || '—'}</b>
                    <span>{bale.status === 'shipped' ? '已出库' : bale.status || '—'}</span>
                  </div>
                  <p>条码 {bale.barcode || '—'}</p>
                  <p>提单 {bale.bl_no || '—'} · 合同 {bale.contract_no || '—'}</p>
                  <p>
                    规格 {bale.thickness}×{bale.width}×{bale.length_text ?? bale.length} ·{' '}
                    {bale.pieces_text ?? bale.pieces} 片 · {formatCubic(bale.cubic)} m³
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
                  setUndoTarget({ id: detail.id, order_no: detail.order_no } as OutboundListItem)
                }}
              >
                撤销出库
              </button>
              <button type="button" className="m-btn m-btn-ghost" onClick={() => setDetail(null)}>
                关闭
              </button>
            </div>
          </>
        ) : null}
      </MobileSheet>

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
            <span className="m-field-label">客户</span>
            <input
              className="m-input"
              value={draft.customer}
              placeholder="客户关键字"
              onChange={(event) => setDraft((prev) => ({ ...prev, customer: event.target.value }))}
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

      <MobileSheet
        open={Boolean(undoTarget)}
        title="撤销这张出库单？"
        onClose={() => setUndoTarget(null)}
      >
        <p style={{ color: 'var(--ink-2)', fontSize: 'var(--t-15)' }}>
          {undoTarget?.order_no} 会被移入回收站，库存回退到出库前，之后可以恢复。
        </p>
        <div className="m-sheet-actions">
          <button
            type="button"
            className="m-btn m-btn-danger"
            disabled={undoing}
            onClick={() => void confirmUndo()}
          >
            {undoing ? '处理中…' : '确认撤销'}
          </button>
          <button type="button" className="m-btn m-btn-ghost" onClick={() => setUndoTarget(null)}>
            取消
          </button>
        </div>
      </MobileSheet>

      <MobileToastHost items={[toast]} />
    </div>
  )
}
