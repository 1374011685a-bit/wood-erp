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
import { Loading } from './Ui'

type Status = 'checking' | 'ok' | 'anonymous'

/** 包住所有业务页面：没有 token 直接跳登录，token 失效则清掉再跳 */
export default function RequireAuth({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>(() =>
    getToken() ? 'checking' : 'anonymous',
  )

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

  if (status === 'checking') {
    return (
      <div className="auth-checking">
        <Loading text="正在校验登录状态…" />
      </div>
    )
  }

  return <>{children}</>
}
