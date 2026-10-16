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

    /**
     * 只在**被键盘挡住**的时候才滚：把输入框抬到键盘上沿之上、留 24px 余量。
     *
     * ⚠️ 这里的判断方向以前写反了（`hidden > -24` 就 return，然后 scrollBy(hidden - 24)）：
     *    输入框在可视区**里面**时 hidden 是很大的负数 → 反而触发 scrollBy(负数) →
     *    页面被往上推一大截。实测：滚到 724 点第 3 行的「片数」，页面跳到 212；
     *    滚到 1200 点「供应商」，直接跳回 0（用户报的"点框就跳最顶上"）。
     *    现在改成：只有 bottom 超过可视区底部（hidden > 0）才滚，且只滚超出那点距离。
     *
     * 另外用 vv.offsetTop 换算成"相对可视区"的坐标：键盘弹出时可视区可能整体上移，
     * 直接用 getBoundingClientRect()（相对布局视口）会算多。
     */
    const reveal = () => {
      const el = document.activeElement
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return
      const rect = el.getBoundingClientRect()
      // 输入框底部相对**可视区**的位置，超出可视区底部多少才算被挡住
      const hidden = rect.bottom - vv.offsetTop - vv.height
      if (hidden <= 24) return
      window.scrollBy({ top: hidden + 24, behavior: 'smooth' })
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
