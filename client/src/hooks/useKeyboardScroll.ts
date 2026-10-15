import { useEffect } from 'react'

/**
 * 手机端键盘避让。
 *
 * 系统键盘弹出来时，可视区（visualViewport）会变矮；聚焦的输入框如果在
 * 下半屏，就会被键盘盖住 —— 用户看不见自己在打什么。这里在聚焦 / 可视区变化时
 * 把输入框滚到**键盘上方**留一点余量的位置。
 *
 * 只处理 input / textarea；桌面端 visualViewport 高度不变，等于不做事。
 */
export function useKeyboardScroll(enabled = true) {
  useEffect(() => {
    if (!enabled) return
    const vv = window.visualViewport
    if (!vv) return

    const reveal = () => {
      const el = document.activeElement
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return
      const rect = el.getBoundingClientRect()
      // 键盘上沿以下（可视区底部）就算被挡住
      const hidden = rect.bottom - vv.height
      if (hidden > -24) return
      window.scrollBy({ top: hidden - 24, behavior: 'smooth' })
    }

    const onFocusIn = () => window.setTimeout(reveal, 260)
    document.addEventListener('focusin', onFocusIn)
    vv.addEventListener('resize', reveal)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      vv.removeEventListener('resize', reveal)
    }
  }, [enabled])
}
