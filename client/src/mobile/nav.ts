import type { NavigateFunction } from 'react-router-dom'

/**
 * 「从哪来回哪去」：优先退一步（navigate(-1)），历史不够才回兜底页。
 *
 * React Router 会把 `history.state.idx` 记成当前历史位置（首页/第一条是 0）。
 * 直接粘链接进来时 idx 是 0，退一步会退出站点，所以这时候才走兜底。
 */
export function goBack(navigate: NavigateFunction, fallback: string) {
  const idx = Number((window.history.state as { idx?: number } | null)?.idx ?? 0)
  if (idx > 0) {
    navigate(-1)
    return
  }
  navigate(fallback, { replace: true })
}
