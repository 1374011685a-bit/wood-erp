import express from 'express'
import bcrypt from 'bcryptjs'
import { db } from '../db.js'
import { ROLES, ROLE_LABELS, isRole } from '../permissions.js'

/**
 * 用户管理（只有 admin 能进，挂在 index.js 上用 requireCap('user.admin')）。
 *
 * 三条硬约束，都是为了「别把自己锁在门外」：
 *   1. 不能停用 / 降级最后一个还能用的管理员；
 *   2. 不能停用自己（误点一下就把自己踢出去了）；
 *   3. 改角色 / 停用 / 重置密码都要把 token_version 加一，
 *      否则对方手上那个 7 天的 token 还照样能用，等于没改。
 *
 * 不提供「删除用户」：删了以后 created_by / operator 这些审计字段就成孤儿了。
 * 要停用就用 active = 0。
 */

const router = express.Router()

const BCRYPT_ROUNDS = 10
const PASSWORD_MIN = 6
const USERNAME_MIN = 3
const USERNAME_MAX = 32

/** 列表：绝不返回 password_hash */
const listStmt = db.prepare(
  `SELECT id, username, role, active, token_version, created_at
     FROM users ORDER BY id`,
)
const findByIdStmt = db.prepare(
  `SELECT id, username, role, active, token_version, created_at
     FROM users WHERE id = ?`,
)
const findByUsernameStmt = db.prepare(`SELECT id FROM users WHERE username = ?`)
const insertUserStmt = db.prepare(
  `INSERT INTO users (username, password_hash, role, active, token_version)
   VALUES (@username, @password_hash, @role, 1, 0)`,
)
const updateRoleStmt = db.prepare(
  `UPDATE users SET role = @role, token_version = token_version + 1 WHERE id = @id`,
)
const updateActiveStmt = db.prepare(
  `UPDATE users SET active = @active, token_version = token_version + 1 WHERE id = @id`,
)
const updatePasswordStmt = db.prepare(
  `UPDATE users SET password_hash = @password_hash, token_version = token_version + 1
    WHERE id = @id`,
)
/** 还剩几个「能用（active=1）的管理员」——用来拦住把自己锁死 */
const activeAdminCountStmt = db.prepare(
  `SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND active = 1`,
)

/** 库里那一行 → 给前端的形状（带角色中文名，省得前端再映射一遍） */
const toApi = (row) => ({
  id: row.id,
  username: row.username,
  role: row.role,
  role_label: ROLE_LABELS[row.role] ?? row.role,
  active: Boolean(row.active),
  created_at: row.created_at,
})

/** 参数校验的公共部分 */
function checkUsername(raw) {
  const username = String(raw ?? '').trim()
  if (!username) return { error: '用户名不能为空' }
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
    return { error: `用户名长度要在 ${USERNAME_MIN}~${USERNAME_MAX} 之间` }
  }
  if (/[\s/\\]/.test(username)) return { error: '用户名不能有空格或斜杠' }
  return { username }
}

function checkPassword(raw) {
  const password = String(raw ?? '')
  if (password.length < PASSWORD_MIN) {
    return { error: `密码至少 ${PASSWORD_MIN} 位` }
  }
  return { password }
}

/** 传进来的角色合法吗 */
function checkRole(raw) {
  const role = String(raw ?? '').trim()
  if (!isRole(role)) {
    return { error: `角色只能是：${ROLES.map((r) => `${r}（${ROLE_LABELS[r]}）`).join('、')}` }
  }
  return { role }
}

/** 目标用户存在吗（不存在就直接回 404 并返回 null） */
function loadTarget(req, res) {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: '用户 ID 不合法' })
    return null
  }
  const target = findByIdStmt.get(id)
  if (!target) {
    res.status(404).json({ error: '用户不存在' })
    return null
  }
  return target
}

/* ---------- 列表 ---------- */

router.get('/', (_req, res) => {
  res.json({ roles: ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] })), rows: listStmt.all().map(toApi) })
})

/* ---------- 开号 ---------- */

router.post('/', (req, res) => {
  const body = req.body ?? {}

  const nameCheck = checkUsername(body.username)
  if (nameCheck.error) return res.status(400).json({ error: nameCheck.error })

  const pwdCheck = checkPassword(body.password)
  if (pwdCheck.error) return res.status(400).json({ error: pwdCheck.error })

  const roleCheck = checkRole(body.role)
  if (roleCheck.error) return res.status(400).json({ error: roleCheck.error })

  if (findByUsernameStmt.get(nameCheck.username)) {
    return res.status(400).json({ error: `用户名 ${nameCheck.username} 已经被占用了` })
  }

  try {
    const result = insertUserStmt.run({
      username: nameCheck.username,
      password_hash: bcrypt.hashSync(pwdCheck.password, BCRYPT_ROUNDS),
      role: roleCheck.role,
    })
    res.json(toApi(findByIdStmt.get(result.lastInsertRowid)))
  } catch (err) {
    // 唯一索引兜底（并发下同一个用户名同时提交）
    if (String(err?.message ?? '').includes('UNIQUE')) {
      return res.status(400).json({ error: `用户名 ${nameCheck.username} 已经被占用了` })
    }
    throw err
  }
})

/* ---------- 改角色 / 停用启用 ---------- */

router.put('/:id', (req, res) => {
  const target = loadTarget(req, res)
  if (!target) return

  const body = req.body ?? {}
  const wantsRole = body.role !== undefined
  const wantsActive = body.active !== undefined

  if (!wantsRole && !wantsActive) {
    return res.status(400).json({ error: '没有要改的内容' })
  }

  let nextRole = target.role
  if (wantsRole) {
    const roleCheck = checkRole(body.role)
    if (roleCheck.error) return res.status(400).json({ error: roleCheck.error })
    nextRole = roleCheck.role
  }

  let nextActive = Boolean(target.active)
  if (wantsActive) {
    nextActive = Boolean(body.active)
  }

  // 约束 1：不能把最后一个还能用的管理员降级或停用
  const losingAdmin =
    target.role === 'admin' &&
    Boolean(target.active) &&
    (nextRole !== 'admin' || !nextActive)
  if (losingAdmin && activeAdminCountStmt.get().total <= 1) {
    return res.status(400).json({
      error:
        '这是最后一个还在用的管理员，不能降级或停用——否则没人能管理系统了。请先另建一个管理员。',
    })
  }

  // 约束 2：不能停用自己（降自己的级也一样危险，一并拦掉）
  if (target.id === req.user.id && (!nextActive || nextRole !== target.role)) {
    return res.status(400).json({ error: '不能修改自己的角色或停用自己的账号' })
  }

  try {
    if (wantsRole && nextRole !== target.role) {
      updateRoleStmt.run({ role: nextRole, id: target.id })
    }
    if (wantsActive && nextActive !== Boolean(target.active)) {
      updateActiveStmt.run({ active: nextActive ? 1 : 0, id: target.id })
    }
    res.json(toApi(findByIdStmt.get(target.id)))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/* ---------- 管理员重置别人的密码 ---------- */

router.post('/:id/reset-password', (req, res) => {
  const target = loadTarget(req, res)
  if (!target) return

  const pwdCheck = checkPassword(req.body?.newPassword)
  if (pwdCheck.error) return res.status(400).json({ error: pwdCheck.error })

  try {
    updatePasswordStmt.run({
      password_hash: bcrypt.hashSync(pwdCheck.password, BCRYPT_ROUNDS),
      id: target.id,
    })
    res.json({ ok: true, username: target.username })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
