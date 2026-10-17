import { useEffect, useRef } from 'react'

const PREFIX = 'wood-mobile-scroll:'

const readScroll = (key: string) => {
  try {
    return Math.max(0, Number(sessionStorage.getItem(PREFIX + key) ?? 0) || 0)
  } catch {
    return 0
  }
}

const saveScroll = (key: string, top: number) => {
  try {
    sessionStorage.setItem(PREFIX + key, String(Math.max(0, Math.round(top))))
  } catch {
    // 隐私模式下写不了就退化成不记忆
  }
}

/** 页面滚动位置记忆；ready=true 时再恢复，避免内容未撑开。 */
export function useMobileScrollMemory(key: string, ready = true) {
  const restoredRef = useRef(false)
  const rafRef = useRef(0)

  useEffect(() => {
    restoredRef.current = false
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
  }, [key])

  useEffect(() => {
    if (!ready || restoredRef.current) return
    restoredRef.current = true
    const top = readScroll(key)
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        window.scrollTo({ top, behavior: 'auto' })
      })
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [key, ready])

  useEffect(() => {
    const onScroll = () => {
      if (rafRef.current) return
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0
        saveScroll(key, window.scrollY)
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      saveScroll(key, window.scrollY)
    }
  }, [key])
}
