/**
 * 在线 / 离线状态（全站共用一个）。
 *
 * 判断依据两块：
 *   1) `navigator.onLine` + online / offline 事件 —— 拔网线、关 WiFi、开飞行模式
 *   2) **网络层错误** —— 服务端挂了、DNS 解析不了、请求超时：这些情况下
 *      `navigator.onLine` 还是 true，但用户实际上什么都做不了，也算离线
 *
 * ⚠️ **4xx / 5xx 不算离线** —— 那是服务端的业务/程序错误，网是通的，
 * 用户该看到的是具体的报错（"提单号重复"这种），不是"当前离线"。
 *
 * 任何一次成功的请求都会自动把状态拉回在线。
 */

let offline = typeof navigator !== 'undefined' ? navigator.onLine === false : false
const listeners = new Set<() => void>()

const emit = () => {
  for (const fn of listeners) fn()
}

const setOffline = (next: boolean) => {
  if (offline === next) return
  offline = next
  emit()
}

/** 这个错误算不算「网络层」错误 */
export function isNetworkError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  // fetch 连不上时浏览器抛的就是 TypeError（Failed to fetch / Load failed）
  if (err instanceof TypeError) return true
  const message = err instanceof Error ? err.message : String(err ?? '')
  return /abort|timeout|超时|Failed to fetch|NetworkError|Load failed|ERR_/i.test(message)
}

/** 请求成功 / 连上了 → 标回在线 */
export function reportNetworkOk() {
  setOffline(false)
}

/** 请求失败 → 只有网络层错误才标离线 */
export function reportNetworkError(err: unknown) {
  if (isNetworkError(err)) setOffline(true)
}

export function subscribeNetwork(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export const isOffline = () => offline

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => setOffline(false))
  window.addEventListener('offline', () => setOffline(true))
}
