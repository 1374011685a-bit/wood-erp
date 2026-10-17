/**
 * 手机端专用组件（第 2 刀）。
 *
 * 一套**独立的** UI 层：api / hooks / utils 和桌面端共用，但渲染完全分开 ——
 * CSS 覆盖做不出大厂手感，所以这里是新写的组件，不复用桌面那几个。
 * 数值全部走第 1 刀的 token（见 mobile.css）。
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import './mobile.css'

/* ============ 列表 ============ */

export function MobileList({ children }: { children: ReactNode }) {
  return <div className="m-list">{children}</div>
}

export function MobileListItem({
  title,
  sub,
  trail,
  icon,
  dense,
  onClick,
}: {
  title: string
  sub?: string
  trail?: ReactNode
  icon?: ReactNode
  /** 钉钉那种密度：主信息 15/600、副信息 13 灰（默认 17/500 + 15） */
  dense?: boolean
  onClick?: () => void
}) {
  return (
    <button type="button" className={dense ? 'm-item is-dense' : 'm-item'} onClick={onClick}>
      {icon ? <span className="m-item-icon">{icon}</span> : null}
      <span className="m-item-main">
        <span className="m-item-title">{title}</span>
        {sub ? <span className="m-item-sub">{sub}</span> : null}
      </span>
      {trail ? <span className="m-item-trail">{trail}</span> : null}
    </button>
  )
}

/* ============ 卡片 ============ */

export function MobileCard({
  title,
  hint,
  className,
  style,
  children,
}: {
  title?: string
  /** 标题后面的浅色小字（比如「明细 3 行」），比主标题轻一档 */
  hint?: ReactNode
  /** 追加类名（首页要加 m-rise / m-todo-card 这类） */
  className?: string
  style?: CSSProperties
  children: ReactNode
}) {
  return (
    <section className={className ? `m-card ${className}` : 'm-card'} style={style}>
      {title ? (
        <h2 className="m-card-title">
          {title}
          {hint ? <span className="m-card-hint">{hint}</span> : null}
        </h2>
      ) : null}
      {children}
    </section>
  )
}

/* ============ 搜索框 ============ */

export function MobileSearchBar({
  value,
  placeholder = '搜索',
  onChange,
}: {
  value: string
  placeholder?: string
  onChange: (next: string) => void
}) {
  return (
    <div className="m-search">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.6-3.6" strokeLinecap="round" />
      </svg>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}

/* ============ 输入框 ============ */

export function MobileInput({
  label,
  value,
  placeholder,
  onChange,
  inputMode,
}: {
  label?: string
  value: string
  placeholder?: string
  onChange: (next: string) => void
  inputMode?: 'text' | 'numeric' | 'decimal'
}) {
  return (
    <label className="m-field">
      {label ? <span className="m-field-label">{label}</span> : null}
      <input
        className="m-input"
        value={value}
        placeholder={placeholder}
        inputMode={inputMode}
        enterKeyHint="next"
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}

/* ============ 底部操作栏 ============ */

export function MobileActionBar({
  primary,
  secondary,
  onPrimary,
  onSecondary,
  primaryDisabled,
  primaryLabel = '保存',
  secondaryLabel = '取消',
}: {
  primary?: () => void
  secondary?: () => void
  onPrimary?: () => void
  onSecondary?: () => void
  primaryDisabled?: boolean
  primaryLabel?: string
  secondaryLabel?: string
}) {
  const onClickPrimary = primary ?? onPrimary
  const onClickSecondary = secondary ?? onSecondary
  return (
    <div className="m-actionbar">
      <button
        type="button"
        className="m-btn m-btn-primary"
        disabled={primaryDisabled}
        onClick={onClickPrimary}
      >
        {primaryLabel}
      </button>
      <button type="button" className="m-btn m-btn-ghost" onClick={onClickSecondary}>
        {secondaryLabel}
      </button>
    </div>
  )
}

/* ============ 弹层 ============ */

export function MobileSheet({
  open,
  title,
  titleExtra,
  onClose,
  children,
}: {
  open: boolean
  title?: string
  titleExtra?: ReactNode
  onClose: () => void
  children: ReactNode
}) {
  if (!open) return null
  return (
    <div className="m-overlay" onClick={onClose}>
      <div className="m-sheet" onClick={(event) => event.stopPropagation()}>
        <div className="m-sheet-handle" />
        {title || titleExtra ? (
          <div className="m-sheet-title-row">
            {title ? <h2 className="m-sheet-title">{title}</h2> : null}
            {titleExtra}
          </div>
        ) : null}
        {children}
      </div>
    </div>
  )
}

/* ============ 空态 ============ */

export function MobileEmpty({
  text,
  actionLabel,
  onAction,
}: {
  text: string
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <div className="m-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5v-9Z" strokeLinejoin="round" />
        <path d="M3 7.5 12 12l9-4.5M12 12v9" strokeLinejoin="round" />
      </svg>
      <span className="m-empty-text">{text}</span>
      {actionLabel && onAction ? (
        <button type="button" className="m-btn m-btn-primary m-empty-action" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  )
}

/* ============ 骨架 ============ */

export function MobileSkeleton({ cards = 3 }: { cards?: number }) {
  return (
    <div className="m-skeleton" aria-hidden="true">
      {Array.from({ length: cards }).map((_, i) => (
        <div className="m-skel-card" key={i}>
          <span className="m-skel-line is-title" />
          <span className="m-skel-line" />
          <span className="m-skel-line is-short" />
        </div>
      ))}
    </div>
  )
}

/* ============ Toast ============ */

export type MobileToastItem = {
  id: string
  message: string
  actionLabel?: string
  onAction?: () => void
}

export function MobileToastHost({ items }: { items: Array<MobileToastItem | null> }) {
  const list = items.filter((item): item is MobileToastItem => Boolean(item))
  if (list.length === 0) return null
  return (
    <div className="m-toast-host">
      {list.map((item) => (
        <div className="m-toast" key={item.id}>
          <span>{item.message}</span>
          {item.actionLabel && item.onAction ? (
            <button type="button" className="m-toast-action" onClick={item.onAction}>
              {item.actionLabel}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  )
}

/** Toast 自动消失（和桌面端 3 秒一套口径） */
export function useAutoDismiss(item: MobileToastItem | null, onDone: () => void, ms = 3000) {
  const id = item?.id ?? ''
  const doneRef = useRef(onDone)
  doneRef.current = onDone
  useEffect(() => {
    if (!id) return
    const timer = window.setTimeout(() => doneRef.current(), ms)
    return () => window.clearTimeout(timer)
  }, [id, ms])
}

/** 数字滚动（苹果 Health 那种，400ms --ease-out） */
export function useCountUp(target: number, duration = 400) {
  const [value, setValue] = useState(target)
  const fromRef = useRef(target)
  useEffect(() => {
    const from = fromRef.current
    if (from === target) return
    const start = performance.now()
    let frame = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - (1 - t) ** 3
      const next = from + (target - from) * eased
      fromRef.current = next
      setValue(next)
      if (t < 1) frame = requestAnimationFrame(tick)
      else fromRef.current = target
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [target, duration])
  return value
}

/**
 * 把按钮塞进 MobileLayout 顶栏右侧（「筛选」「+」这种页面级操作）。
 *
 * 用 portal 而不是把按钮留在页面里：顶栏是外壳画出来的，页面自己想往里放东西
 * 只能这样。挂载点由 MobileLayout 提供（`[data-m-topbar-actions]`），
 * 首次渲染时挂载点还没进 DOM，所以用一个 effect 拿到再启 portal。
 */
export function MobileTopbarActions({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setHost(document.querySelector<HTMLElement>('[data-m-topbar-actions]'))
  }, [])
  if (!host) return null
  return createPortal(children, host)
}

/** 顶栏上的一个操作按钮（可带角标数字） */
export function MobileTopbarButton({
  label,
  badge,
  onClick,
}: {
  label: string
  badge?: number
  onClick: () => void
}) {
  return (
    <button type="button" className="m-topbar-act" onClick={onClick}>
      {label}
      {badge && badge > 0 ? <span className="m-topbar-badge">{badge}</span> : null}
    </button>
  )
}

/* ============ 居中弹窗（iOS 标准 270 宽 / 圆角 16） ============ */

export function MobileModal({
  open,
  title,
  message,
  confirmLabel = '确定',
  cancelLabel = '取消',
  danger,
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  if (!open) return null
  return (
    <div className="m-overlay is-center" onClick={onClose}>
      <div className="m-modal" onClick={(event) => event.stopPropagation()}>
        <h2 className="m-modal-title">{title}</h2>
        {message ? <p className="m-modal-text">{message}</p> : null}
        <div className="m-modal-actions">
          <button type="button" className="m-modal-btn" onClick={onClose}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? 'm-modal-btn is-danger' : 'm-modal-btn is-strong'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ============ 下拉选择（用原生 select，iOS 上就是系统滚轮） ============ */

export function MobileSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (next: string) => void
}) {
  return (
    <label className="m-field">
      <span className="m-field-label">{label}</span>
      <select
        className="m-input m-select"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option value={option.value} key={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/** 日期选择：原生 date 输入（手机上是系统日期轮） */
export function MobileDatePicker({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (next: string) => void
}) {
  return (
    <label className="m-field">
      <span className="m-field-label">{label}</span>
      <input
        className="m-input"
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}

/* ============ 角标 / 胶囊 / 段控 / 步进 / 头像 / 图标 ============ */

export function MobileBadge({
  children,
  tone = 'brand',
}: {
  children: ReactNode
  tone?: 'brand' | 'ok' | 'warn' | 'danger'
}) {
  return <span className={`m-badge is-${tone}`}>{children}</span>
}

/** 业务状态标签：11px、小圆角、浅底深字 */
export function MobileStatusTag({
  children,
  tone,
  large,
}: {
  children: ReactNode
  tone: 'success' | 'info' | 'neutral' | 'progress'
  large?: boolean
}) {
  return (
    <span className={`m-status-tag is-${tone}${large ? ' is-large' : ''}`}>
      {children}
    </span>
  )
}

export function MobileChip({
  label,
  active,
  onClick,
}: {
  label: string
  active?: boolean
  onClick: () => void
}) {
  return (
    <button type="button" className={active ? 'm-chip is-on' : 'm-chip'} onClick={onClick}>
      {label}
    </button>
  )
}

export function MobileSegmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (next: T) => void
}) {
  return (
    <div className="m-segmented" role="tablist">
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          role="tab"
          aria-selected={option.value === value}
          className={option.value === value ? 'm-seg-item is-on' : 'm-seg-item'}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function MobileStepper({
  value,
  min = 1,
  max = 99,
  onChange,
}: {
  value: number
  min?: number
  max?: number
  onChange: (next: number) => void
}) {
  return (
    <div className="m-stepper">
      <button
        type="button"
        className="m-step-btn"
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
      >
        −
      </button>
      <span className="m-step-value">{value}</span>
      <button
        type="button"
        className="m-step-btn"
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        ＋
      </button>
    </div>
  )
}

export function MobileAvatar({ name }: { name: string }) {
  return <span className="m-avatar">{(name || '?').trim().charAt(0).toUpperCase()}</span>
}

/** 统一线性图标（2px 描边，只用 20/24/28 三档） */
export function MobileIcon({
  name,
  size = 24,
}: {
  name: 'arrow-left' | 'search' | 'plus' | 'filter' | 'box' | 'user' | 'doc' | 'chart' | 'trash'
  size?: 16 | 20 | 24 | 28
}) {
  const paths: Record<string, ReactNode> = {
    'arrow-left': <path d="M14.5 5.5 8 12l6.5 6.5" />,
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.6-3.6" />
      </>
    ),
    plus: <path d="M12 5.5v13M5.5 12h13" />,
    filter: <path d="M4 6h16M7 12h10M10 18h4" />,
    box: (
      <>
        <path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5v-9Z" />
        <path d="M3 7.5 12 12l9-4.5M12 12v9" />
      </>
    ),
    user: (
      <>
        <circle cx="12" cy="8.3" r="3.9" />
        <path d="M4.9 20.3c.7-3.6 3.6-5.7 7.1-5.7s6.4 2.1 7.1 5.7" />
      </>
    ),
    doc: (
      <>
        <path d="M6.6 3.5h7.1l4.3 4.3v12.7H6.6z" />
        <path d="M13.6 3.5v4.4h4.4M9.4 12.6h5.2M9.4 16.1h5.2" />
      </>
    ),
    chart: <path d="M4.5 19.5v-5M12 19.5V8M19.5 19.5v-8" />,
    trash: (
      <>
        <path d="M5 7h14M10 7V4.8h4V7M6.5 7l1 13h9l1-13" />
      </>
    ),
  }
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  )
}
