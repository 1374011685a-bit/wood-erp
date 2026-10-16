import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'

/* 统一页头：页面标题 + 一句话说明 */
export function PageHead({
  title,
  subtitle,
  extra,
}: {
  title: string
  subtitle?: string
  extra?: ReactNode
}) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {extra ? <div className="modal-actions">{extra}</div> : null}
    </header>
  )
}

/**
 * 空状态。
 *
 * 只给一行灰字，用户看到"没有数据"就不知道下一步该干嘛；
 * 传了 `action` 就在下面给一个主按钮（"去采购入库"这种），能直接顺着走下去。
 */
export function EmptyState({
  text = '暂无数据',
  hint,
  action,
}: {
  text?: string
  hint?: string
  action?: { label: string; to?: string; onClick?: () => void }
}) {
  const navigate = useNavigate()
  const go = () => {
    if (action?.onClick) action.onClick()
    else if (action?.to) navigate(action.to)
  }

  return (
    <div className="empty">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5v-9Z" />
        <path d="M3 7.5 12 12l9-4.5" />
        <path d="M12 12v9" />
      </svg>
      <span>{text}</span>
      {hint ? <span className="empty-hint">{hint}</span> : null}
      {action ? (
        <button type="button" className="btn btn-primary empty-action" onClick={go}>
          {action.label}
        </button>
      ) : null}
    </div>
  )
}

/* 加载中 */
export function Loading({ text = '加载中…' }: { text?: string }) {
  return (
    <div className="loading">
      <span className="spinner" />
      <span>{text}</span>
    </div>
  )
}

/**
 * 列表加载中的骨架屏：几条灰块占位。
 *
 * 比一个居中的转圈稳 —— 数据到了以后版面不会整页跳一下，
 * 而且一眼就能看出"这里将来是一张表"。只用在外层列表页；
 * 弹窗里那种小块区域继续用 <Loading/> 转圈。
 */
export function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="skeleton" aria-hidden="true">
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div className="skeleton-row" key={rowIndex}>
          {Array.from({ length: cols }).map((__, colIndex) => (
            <span
              className={colIndex === 0 ? 'skeleton-cell is-wide' : 'skeleton-cell'}
              key={colIndex}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * 切页时的加载指示：顶栏下面一条来回走的细进度条 + 一块表形骨架。
 *
 * 路由是懒加载的，点到没下载过的功能要等一小会儿 —— 光给一条进度条的话，
 * 下面还是空的；配一块骨架至少看着像"页面正在长出来"。
 */
export function RouteProgress() {
  return (
    <div className="route-progress-host">
      <div className="route-progress" role="progressbar" aria-label="页面加载中" />
      <TableSkeleton rows={4} cols={4} />
    </div>
  )
}

/**
 * 下拉刷新的指示器（只有手机端会拉出来）。
 * 文案跟着距离走：下拉刷新 → 松手刷新 → 刷新中…
 */
export function PullIndicator({ distance, busy }: { distance: number; busy: boolean }) {
  if (distance <= 0) return null
  const text = busy ? '刷新中…' : distance >= 52 ? '松手刷新' : '下拉刷新'
  return (
    <div className="pull-indicator" style={{ height: distance, opacity: Math.min(1, distance / 40) }}>
      <span className={busy ? 'pull-spinner is-spinning' : 'pull-spinner'} />
      <span>{text}</span>
    </div>
  )
}

/* 首页数字卡片 */
export function StatCard({
  label,
  value,
  unit,
  sub,
  tone,
}: {
  label: string
  value: string
  unit?: string
  sub?: string
  tone?: 'blue' | 'orange' | 'green' | 'red'
}) {
  return (
    <div className={tone ? `stat-card stat-${tone}` : 'stat-card'}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">
        {value}
        {unit ? <span className="stat-unit">{unit}</span> : null}
      </div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  )
}

/* 顶部浮层提示 */
/* 列表分页条：左侧显示总数，右侧上一页 / 页码 / 下一页 */
export function Pager({
  total,
  limit,
  offset,
  onChange,
  unit = '条',
}: {
  total: number
  limit: number
  offset: number
  onChange: (offset: number) => void
  unit?: string
}) {
  const pages = Math.max(1, Math.ceil(total / limit))
  const page = Math.min(pages, Math.floor(offset / limit) + 1)

  return (
    <div className="pager">
      <span className="pager-total">
        共 {total} {unit}
      </span>
      <div className="pager-nav">
        <button
          type="button"
          className="pager-btn"
          onClick={() => onChange(Math.max(0, offset - limit))}
          disabled={page <= 1}
          aria-label="上一页"
        >
          ‹
        </button>
        <span className="pager-page">
          {page} / {pages}
        </span>
        <button
          type="button"
          className="pager-btn"
          onClick={() => onChange(Math.min((pages - 1) * limit, offset + limit))}
          disabled={page >= pages}
          aria-label="下一页"
        >
          ›
        </button>
      </div>
    </div>
  )
}

export type ToastItem = {
  id: string
  kind?: 'success' | 'error' | 'info'
  message: string
  onClose: () => void
  /**
   * 可选的一个「撤销」按钮（保存 / 删除之后 3 秒内可点）。
   * 点了会先关掉这条提示，再执行 action。
   */
  actionLabel?: string
  onAction?: () => void
}

function Toast({ item }: { item: ToastItem }) {
  const closeRef = useRef(item.onClose)
  closeRef.current = item.onClose

  // 短消息 3 秒自动消失；长报错（需要照着改的）留到手动关闭
  const duration =
    item.kind === 'error' && item.message.length > 60 ? 0 : 3000

  useEffect(() => {
    if (duration === 0) return
    const timer = window.setTimeout(() => closeRef.current(), duration)
    return () => window.clearTimeout(timer)
  }, [duration, item.id, item.message])

  return (
    <div className={`toast toast-${item.kind ?? 'success'}`}>
      <span className="toast-text">{item.message}</span>
      {item.actionLabel && item.onAction && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            item.onClose()
            item.onAction?.()
          }}
        >
          {item.actionLabel}
        </button>
      )}
      <button
        type="button"
        className="toast-close"
        onClick={item.onClose}
        aria-label="关闭"
      >
        ×
      </button>
    </div>
  )
}

export function ToastHost({ items }: { items: Array<ToastItem | null> }) {
  const list = items.filter((item): item is ToastItem => Boolean(item))
  if (list.length === 0) return null

  return (
    <div className="toast-host">
      {list.map((item) => (
        <Toast key={item.id} item={item} />
      ))}
    </div>
  )
}

