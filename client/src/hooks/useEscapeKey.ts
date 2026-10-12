import { useEffect, useRef } from 'react'

/**
 * 按 Esc 触发回调。
 * 苹果的弹层/菜单都是 Esc 即关，这里抽出来给各处复用。
 * enabled 为 false 时不监听，避免叠加的弹层一次关掉两个。
 */
export function useEscapeKey(enabled: boolean, onEscape: () => void) {
  const handlerRef = useRef(onEscape)
  handlerRef.current = onEscape

  useEffect(() => {
    if (!enabled) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handlerRef.current()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [enabled])
}
