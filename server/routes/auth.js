import express from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { db } from '../db.js'
import { requireAuth } from '../middleware/auth.js'

const router = express.Router()

const TOKEN_TTL = '7d'
const BCRYPT_ROUNDS = 10

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

export default router
