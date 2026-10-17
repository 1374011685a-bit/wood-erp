import type { NavigateFunction } from 'react-router-dom'

const FADE_MS = 300
const HOLD_MS = 800
const OVERLAY_ID = 'login-transition-overlay'

let running = false

/**
 * 登录成功后的跨路由过渡遮罩。
 *
 * 遮罩挂在 body 上，不随 Login 组件卸载；首页在遮罩下面完成首次渲染和淡入，
 * 遮罩最后淡出 300ms，避免“登录页 -> 白屏 -> 首页”的硬切。
 */
export function runLoginTransition(navigate: NavigateFunction) {
  if (running) return
  running = true

  const overlay = document.createElement('div')
  overlay.id = OVERLAY_ID
  overlay.className = 'login-transition-overlay'
  overlay.setAttribute('role', 'status')
  overlay.setAttribute('aria-live', 'polite')
  overlay.innerHTML = `
    <div class="login-transition-content">
      <img src="/logo.png" alt="" />
      <p>正在进入立川云…</p>
    </div>
  `
  document.body.appendChild(overlay)

  requestAnimationFrame(() => {
    overlay.classList.add('is-visible')
  })

  window.setTimeout(() => {
    navigate('/', { replace: true })
    overlay.classList.add('is-leaving')
    window.setTimeout(() => {
      overlay.remove()
      running = false
    }, FADE_MS + 30)
  }, FADE_MS + HOLD_MS)
}
