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
import { tapHeavy, tapLight, tapMedium } from '../utils/haptics'
import {
  MobileEmpty,
  MobileList,
  MobileListItem,
  MobileSearchBar,
  MobileSheet,
  MobileSkeleton,
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
                trail={row.order_date?.slice(5) ?? ''}
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
        onClose={() => setDetail(null)}
      >
        {detail ? (
          <>
            <div className="m-rows">
              {[
                ['供应商', detail.supplier || '—'],
                ['入库日期', detail.order_date || '—'],
                ['仓库', detail.warehouse || '—'],
                ['提单号', detail.bl_no || '—'],
                ['合同号', detail.contract_no || '—'],
                ['总立方', `${formatCubic(detail.total_cubic)} m³`, true],
                ['总金额', `${formatAmount(detail.total_amount)} 元`, true],
                ['明细数', String(detail.items.length)],
              ].map(([label, value, isNum]) => (
                <div className="m-row" key={label as string}>
                  <span className="m-row-label">{label as string}</span>
                  <span className={isNum ? 'm-row-value is-num' : 'm-row-value'}>{value as string}</span>
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
