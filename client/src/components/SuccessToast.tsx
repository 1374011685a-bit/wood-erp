import { useEffect, useRef, useState } from 'react'

export default function SuccessToast({
  open,
  title,
  subtitle,
  duration = 1500,
  onDone,
}: {
  open: boolean
  title: string
  subtitle: string
  duration?: number
  onDone?: () => void
}) {
  const [closing, setClosing] = useState(false)
  const doneRef = useRef(onDone)
  doneRef.current = onDone

  useEffect(() => {
    if (!open) {
      setClosing(false)
      return
    }
    setClosing(false)
    const closeTimer = window.setTimeout(
      () => setClosing(true),
      Math.max(0, duration - 220),
    )
    const doneTimer = window.setTimeout(() => doneRef.current?.(), duration)
    return () => {
      window.clearTimeout(closeTimer)
      window.clearTimeout(doneTimer)
    }
  }, [open, duration])

  if (!open) return null

  return (
    <div
      className={closing ? 'success-toast-overlay is-closing' : 'success-toast-overlay'}
      role="status"
      aria-live="polite"
    >
      <div className="success-toast-box">
        <span className="success-toast-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path
              d="m6.8 12.3 3.4 3.4 7.2-7.3"
              stroke="currentColor"
              strokeWidth="2.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="success-toast-copy">
          <b>{title}</b>
          <small>{subtitle}</small>
        </span>
      </div>
    </div>
  )
}
