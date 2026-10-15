import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

/** 闪屏出现的时间点：用来保证它至少露一下脸，别"闪"一下就没了 */
const startedAt = Date.now()

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

/*
 * 把 index.html 里那块启动闪屏淡出移除。
 * 至少显示 320ms：本机加载很快时（几十毫秒），闪屏一闪而过反而更像是卡了一下。
 */
const splash = document.getElementById('boot-splash')
if (splash) {
  const remove = () => splash.remove()
  splash.addEventListener('transitionend', remove)
  window.setTimeout(
    () => {
      splash.classList.add('is-hidden')
      // 兜底：去掉 prefers-reduced-motion 的机器上不会触发 transitionend
      window.setTimeout(remove, 400)
    },
    Math.max(0, 320 - (Date.now() - startedAt)),
  )
}
