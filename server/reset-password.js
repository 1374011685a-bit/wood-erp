/**
 * 忘记密码时的本机重置工具。
 *
 * 用法（必须在服务停止的状态下执行，否则会被运行中的服务覆盖）：
 *   node server/reset-password.js              # 给 admin 生成一个随机新密码
 *   node server/reset-password.js admin 新密码  # 指定用户名和新密码
 */
import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { db, dbPath } from './db.js'

const [, , usernameArg, passwordArg] = process.argv
const username = (usernameArg || 'admin').trim()

const user = db
  .prepare(`SELECT id, username FROM users WHERE username = ?`)
  .get(username)

if (!user) {
  const all = db.prepare(`SELECT username FROM users`).all()
  console.error(`[重置失败] 没有找到用户：${username}`)
  console.error(
    `           现有用户：${all.map((row) => row.username).join('、') || '（无）'}`,
  )
  process.exit(1)
}

const password = passwordArg?.trim() || crypto.randomBytes(9).toString('base64url')

db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(
  bcrypt.hashSync(password, 10),
  user.id,
)

console.log(`数据库：${dbPath}`)
console.log(`已把用户 ${user.username} 的密码重置为：${password}`)
console.log('用新密码登录后，请到右上角「修改密码」改成自己的密码。')
