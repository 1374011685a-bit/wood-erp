import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import {
  clearSession,
  fetchMe,
  getToken,
  setStoredUsername,
} from '../api'
import { setStoredRole } from '../permissions'
import BootSplash from './BootSplash'

type Status = 'checking' | 'ok' | 'anonymous'

/** 包住所有业务页面：没有 token 直接跳登录，token 失效则清掉再跳 */
export default function RequireAuth({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>(() =>
    getToken() ? 'checking' : 'anonymous',
  )
  const [splashExpired, setSplashExpired] = useState(false)

  useEffect(() => {
    const startedAt = Number(
      (window as Window & { __woodBootStartedAt?: number }).__woodBootStartedAt ??
        performance.now(),
    )
    const timer = window.setTimeout(
      () => setSplashExpired(true),
      Math.max(0, 2000 - (performance.now() - startedAt)),
    )
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (status !== 'checking') return

    let cancelled = false
    void fetchMe()
      .then((me) => {
        if (cancelled) return
        setStoredUsername(me.username)
        // 角色存下来，页面里的 useRole() 直接读；以服务端返回的为准
        setStoredRole(me.role)
        setStatus('ok')
      })
      .catch(() => {
        if (cancelled) return
        clearSession()
        setStatus('anonymous')
      })

    return () => {
      cancelled = true
    }
  }, [status])

  if (status === 'anonymous') {
    return <Navigate to="/login" replace />
  }

  if (status === 'checking' && !splashExpired) {
    /*
     * 校验登录态期间显示品牌闪屏（和 index.html 里那块同款）：
     * 用户看到的是"应用正在启动"，而不是一屏灰底 + 一行小字。
     */
    return <BootSplash />
  }

  if (status === 'checking') {
    return (
      <div className="auth-checking-fallback">
        <span className="auth-checking-spinner" aria-hidden="true" />
        <p>正在连接服务器…</p>
      </div>
    )
  }

  return <>{children}</>
}
