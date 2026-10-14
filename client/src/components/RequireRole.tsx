import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useRole } from '../hooks/useRole'
import type { Role } from '../permissions'

/**
 * 路由级的角色闸门：不在 allow 里的角色直接送回首页。
 *
 * 这只是「别让用户点进一个他什么都看不了的页面」，
 * 真正的拦截在后端 —— 就算有人改前端代码绕过这里，接口照样回 403。
 */
export default function RequireRole({
  allow,
  children,
}: {
  allow: Role[]
  children: ReactNode
}) {
  const role = useRole()
  if (!allow.includes(role)) return <Navigate to="/" replace />
  return <>{children}</>
}
