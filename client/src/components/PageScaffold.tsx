import type { ReactNode } from 'react'

export function PageContainer({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return <div className={`page-container ${className}`.trim()}>{children}</div>
}

export function FilterBar({
  children,
  actions,
  className = '',
}: {
  children: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <section className={`filter-bar ${className}`.trim()}>
      <div className="filter-bar-fields">{children}</div>
      {actions ? <div className="filter-bar-actions">{actions}</div> : null}
    </section>
  )
}

export function DataCard({
  children,
  toolbar,
  footer,
  className = '',
}: {
  children: ReactNode
  toolbar?: ReactNode
  footer?: ReactNode
  className?: string
}) {
  return (
    <section className={`data-card ${className}`.trim()}>
      {toolbar ? <div className="data-card-toolbar">{toolbar}</div> : null}
      <div className="data-card-body">{children}</div>
      {footer ? <div className="data-card-footer">{footer}</div> : null}
    </section>
  )
}
