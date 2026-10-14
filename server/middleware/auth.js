import jwt from 'jsonwebtoken'
import { db } from '../db.js'

/**
 * 校验 Authorization: Bearer <token>
 * 通过后把 payload 挂到 req.user，失败统一返回 401
 *
 * 光验签不够，还必须回查数据库：
 *   - 角色以**数据库为准**：管理员把业务员降成只读后，他手上那个 7 天的
 *     token 里写的还是旧角色，只信 token 就等于没降级；
 *   - token_version 对不上说明改过密码 / 被停用 / 被改过角色 → 登录态作废；
 *   - 账号被停用返回 403，而不是 401（401 会被前端当成「没登录」跳登录页，
 *     那样用户永远看不到「账号已停用」这句提示）。
 *
 * sql.js 是内存库，这条查询是微秒级，每请求查一次可以放心。
 */
const findAuthUserStmt = db.prepare(
  `SELECT id, username, role, active, token_version FROM users WHERE id = ?`,
)

export function requireAuth(req, res, next) {
  const header = req.headers.authorization ?? ''
  const [scheme, token] = header.split(' ')

  if (!token || scheme.toLowerCase() !== 'bearer') {
    return res.status(401).json({ error: '未登录或登录已过期' })
  }

  let payload
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET)
  } catch {
    return res.status(401).json({ error: '未登录或登录已过期' })
  }

  const user = findAuthUserStmt.get(payload.sub)
  if (!user) {
    // 用户被删了，但 token 还在
    return res.status(401).json({ error: '未登录或登录已过期' })
  }
  if (!user.active) {
    return res.status(403).json({ error: '这个账号已被停用，请联系管理员' })
  }
  if (Number(payload.tv ?? 0) !== Number(user.token_version ?? 0)) {
    return res.status(401).json({ error: '登录状态已失效，请重新登录' })
  }

  // role 一律取库里的最新值，token 里那份只当参考
  req.user = { id: user.id, username: user.username, role: user.role }
  return next()
}
