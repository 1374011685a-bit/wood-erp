import { useEffect, useRef, useState } from 'react'

/**
 * 手机端下拉刷新。
 *
 * 只在**页面已经滚到最顶**时才开始跟手，避免和正常滚动抢手势；
 * 拉过 `TRIGGER` 松手才真刷新，刷新期间停在"刷新中"的位置不弹回去。
 * 桌面端不触发（没有 touch 事件），所以同一个 hook 挂着不用管平台。
 */
export function usePullToRefresh(onRefresh: () => void | Promise<void>, enabled = true) {
  const [distance, setDistance] = useState(0)
  const [busy, setBusy] = useState(false)

  const startY = useRef(0)
  const pulling = useRef(false)
  const pulled = useRef(0)
  const busyRef = useRef(false)
  const refresh = useRef(onRefresh)
  refresh.current = onRefresh

  useEffect(() => {
    if (!enabled) return
    const HOLD = 56
    const TRIGGER = 52

    const onStart = (event: TouchEvent) => {
      if (busyRef.current || window.scrollY > 0) return
      startY.current = event.touches[0]?.clientY ?? 0
      pulling.current = true
      pulled.current = 0
    }

    const onMove = (event: TouchEvent) => {
      if (!pulling.current) return
      const dy = (event.touches[0]?.clientY ?? 0) - startY.current
      // 往回滑 / 页面已经滚走了 → 立刻收手，交还给正常滚动
      if (dy <= 0 || window.scrollY > 0) {
        pulling.current = false
        pulled.current = 0
        setDistance(0)
        return
      }
      // 阻尼：手指走 2px，指示器走 1px，最多 96px
      const next = Math.min(96, dy * 0.5)
      pulled.current = next
      setDistance(next)
      if (event.cancelable && next > 4) event.preventDefault()
    }

    const onEnd = async () => {
      if (!pulling.current) return
      pulling.current = false
      const released = pulled.current
      pulled.current = 0
      if (released < TRIGGER) {
        setDistance(0)
        return
      }
      busyRef.current = true
      setBusy(true)
      setDistance(HOLD)
      try {
        await refresh.current()
      } finally {
        busyRef.current = false
        setBusy(false)
        setDistance(0)
      }
    }

    window.addEventListener('touchstart', onStart, { passive: true })
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('touchend', onEnd)
    window.addEventListener('touchcancel', onEnd)
    return () => {
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', onEnd)
    }
  }, [enabled])

  return { distance, busy }
}
