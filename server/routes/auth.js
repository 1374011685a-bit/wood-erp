import express from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { db } from '../db.js'
import { requireAuth } from '../middleware/auth.js'

const router = express.Router()

const TOKEN_TTL = '7d'
const BCRYPT_ROUNDS = 10

// 忘记密码用的「重置口令」：默认 123，可用环境变量 RESET_CODE 覆盖
const RESET_MAX_FAILS = 5
const RESET_WINDOW_MS = 10 * 60 * 1000
const resetFailsByIp = new Map()

const resetCode = () => process.env.RESET_CODE || '123'

function tooManyFails(ip) {
  const record = resetFailsByIp.get(ip)
  if (!record) return false
  if (Date.now() - record.firstAt > RESET_WINDOW_MS) {
    resetFailsByIp.delete(ip)
    return false
  }
  return record.count >= RESET_MAX_FAILS
}

function recordFail(ip) {
  const record = resetFailsByIp.get(ip)
  if (!record || Date.now() - record.firstAt > RESET_WINDOW_MS) {
    resetFailsByIp.set(ip, { count: 1, firstAt: Date.now() })
    return
  }
  record.count += 1
}

const findByUsername = db.prepare(
  `SELECT id, username, password_hash FROM users WHERE username = ?`,
)
const findById = db.prepare(`SELECT id, username FROM users WHERE id = ?`)
const findWithHashById = db.prepare(
  `SELECT id, username, password_hash FROM users WHERE id = ?`,
)
const updatePassword = db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`)

// 用户不存在时也跑一次 bcrypt 校验，避免通过响应时间反推用户名是否存在
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS)

function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: TOKEN_TTL },
  )
}

// 登录（无需 token）
router.post('/login', (req, res) => {
  const username = String(req.body?.username ?? '').trim()
  const password = String(req.body?.password ?? '')

  // 用户不存在和密码错误返回同一句话
  const fail = () => res.status(401).json({ error: '用户名或密码错误' })

  if (!username || !password) return fail()

  const user = findByUsername.get(username)
  let matched = false
  if (user) {
    matched = bcrypt.compareSync(password, user.password_hash)
  } else {
    bcrypt.compareSync(password, DUMMY_HASH)
  }
  if (!matched) return fail()

  res.json({ token: signToken(user), username: user.username })
})

// 当前登录用户
router.get('/me', requireAuth, (req, res) => {
  const user = findById.get(req.user.sub)
  if (!user) {
    return res.status(401).json({ error: '未登录或登录已过期' })
  }
  res.json({ username: user.username })
})

// 修改密码
router.post('/change-password', requireAuth, (req, res) => {
  const oldPassword = String(req.body?.oldPassword ?? '')
  const newPassword = String(req.body?.newPassword ?? '')

  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: '请填写原密码和新密码' })
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: '新密码至少 6 位' })
  }

  const user = findWithHashById.get(req.user.sub)
  if (!user) {
    return res.status(401).json({ error: '未登录或登录已过期' })
  }
  if (!bcrypt.compareSync(oldPassword, user.password_hash)) {
    return res.status(400).json({ error: '原密码不正确' })
  }

  updatePassword.run(bcrypt.hashSync(newPassword, BCRYPT_ROUNDS), user.id)
  res.json({ ok: true })
})

/**
 * 忘记密码：用「重置口令」直接改密码（不需要登录）。
 * 单机部署的过渡方案 —— 口令默认 123，可在 server/.env 里用 RESET_CODE 改掉。
 * 失败次数按 IP 限制（10 分钟内最多 5 次），每次尝试都记审计日志。
 */
router.post('/reset-password', (req, res) => {
  const username = String(req.body?.username ?? '').trim() || 'admin'
  const code = String(req.body?.resetCode ?? '')
  const newPassword = String(req.body?.newPassword ?? '')
  const ip = req.ip ?? 'unknown'

  if (tooManyFails(ip)) {
    return res
      .status(429)
      .json({ error: '重置口令错误次数过多，请 10 分钟后再试' })
  }
  if (!code) {
    return res.status(400).json({ error: '请输入重置口令' })
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: '新密码至少 6 位' })
  }
  if (code !== resetCode()) {
    recordFail(ip)
    console.warn(
      `[auth] 重置口令校验失败：用户=${username} ip=${ip} 时间=${new Date().toISOString()}`,
    )
    return res.status(400).json({ error: '重置口令不正确' })
  }

  const user = findByUsername.get(username)
  if (!user) {
    return res.status(404).json({ error: `用户不存在：${username}` })
  }

  updatePassword.run(bcrypt.hashSync(newPassword, BCRYPT_ROUNDS), user.id)
  resetFailsByIp.delete(ip)
  console.log(`[auth] 用户 ${user.username} 通过重置口令修改了密码（ip=${ip}）`)
  res.json({ ok: true, username: user.username })
})

export default router
