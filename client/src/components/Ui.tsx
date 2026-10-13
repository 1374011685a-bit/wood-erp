import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

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

/* 空状态 */
export function EmptyState({ text = '暂无数据' }: { text?: string }) {
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

