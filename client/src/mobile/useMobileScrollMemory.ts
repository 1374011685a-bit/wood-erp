import { useEffect, useLayoutEffect, useRef } from 'react'

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

  useLayoutEffect(() => {
    restoredRef.current = false
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
  }, [key])

  useLayoutEffect(() => {
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
      // 路由切换时会瞬时把新页面滚到顶部；这不是用户操作，不能覆盖旧位置。
      if (document.documentElement.dataset.mNav) return
      if (rafRef.current) return
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0
        saveScroll(key, window.scrollY)
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    const saveBeforeLeave = () => saveScroll(key, window.scrollY)
    window.addEventListener('pagehide', saveBeforeLeave)
    window.addEventListener('beforeunload', saveBeforeLeave)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('pagehide', saveBeforeLeave)
      window.removeEventListener('beforeunload', saveBeforeLeave)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      /*
       * 这里绝对不能再 saveScroll(key, window.scrollY)：
       * 路由切走时 DOM 已经滚到新页顶部，会把刚记下的旧位置覆盖成 0。
       */
    }
  }, [key])
}
