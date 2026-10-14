import { getStoredRole } from '../permissions'
import type { Role } from '../permissions'

/**
 * 当前登录用户的角色。
 *
 * 角色是在 RequireAuth 里校验登录态时（调 /api/auth/me）写进 localStorage 的，
 * 而 RequireAuth 校验通过之后才渲染业务页面 —— 所以页面里直接读就行，
 * 不需要 context，也不用订阅：角色只会在登录 / 退出时变，那时页面本来就整页重来。
 */
export function useRole(): Role {
  return getStoredRole()
}
