import jwt from 'jsonwebtoken'

/**
 * 校验 Authorization: Bearer <token>
 * 通过后把 payload 挂到 req.user，失败统一返回 401
 */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization ?? ''
  const [scheme, token] = header.split(' ')

  if (!token || scheme.toLowerCase() !== 'bearer') {
    return res.status(401).json({ error: '未登录或登录已过期' })
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET)
    return next()
  } catch {
    return res.status(401).json({ error: '未登录或登录已过期' })
  }
}
