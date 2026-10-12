import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import bcrypt from 'bcryptjs'
import Database from 'better-sqlite3'

const serverDir = path.dirname(fileURLToPath(import.meta.url))

// 数据库文件在模块加载时就要定位，所以这里先把 server/.env 读进来（幂等）
dotenv.config({ path: path.join(serverDir, '.env'), quiet: true })

/**
 * 数据库目录：
 * - 生产（Railway / Sealos）用 DATA_DIR=/data 指向挂载卷
 * - 本地不配 DATA_DIR 时仍落在 server/，沿用现有的 server/data.db，不会丢数据
 *
 * 目录不存在会自动创建；万一 DATA_DIR 不可写（卷没挂上、只读、权限不足），
 * 自动回退到 server 目录并打警告，保证容器不会因为一个目录就起不来。
 */
function resolveDataDir() {
  const configured = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : serverDir

  const candidates = configured === serverDir ? [configured] : [configured, serverDir]
  const failures = []

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      if (dir !== configured) {
        fs.writeSync(
          2,
          `[警告] DATA_DIR 不可用（${configured}），已回退到 ${dir}，数据不会持久化，请检查挂载卷\n`,
        )
      }
      return dir
    } catch (err) {
      failures.push(`${dir}（${err.code ?? err.message}）`)
    }
  }

  throw new Error(
    `数据目录不可写：${failures.join('、')}。请检查 DATA_DIR 环境变量与挂载卷权限`,
  )
}

export const dataDir = resolveDataDir()

export const dbPath = path.join(dataDir, 'data.db')

export const db = new Database(dbPath)

// 本地单机使用：WAL 提升并发写入表现，并开启外键约束
// 个别挂载卷（网络盘等）不支持 WAL，失败就退回默认模式，不影响使用
try {
  db.pragma('journal_mode = WAL')
} catch (err) {
  fs.writeSync(2, `[警告] 开启 WAL 失败（${err.message}），继续使用默认日志模式\n`)
}
db.pragma('foreign_keys = ON')

const schema = `
  -- 入库单头
  CREATE TABLE IF NOT EXISTS inbound_orders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no   TEXT    NOT NULL UNIQUE,
    supplier   TEXT,
    order_date TEXT,
    remark     TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  -- 出库单头
  CREATE TABLE IF NOT EXISTS outbound_orders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no   TEXT    NOT NULL UNIQUE,
    customer   TEXT,
    order_date TEXT,
    remark     TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  -- 出入库明细（order_type 区分：in 入库 / out 出库）
  -- cubic 与 amount 在写入时算好存下，查询时不再重算
  CREATE TABLE IF NOT EXISTS order_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id   INTEGER NOT NULL,
    order_type TEXT    NOT NULL CHECK (order_type IN ('in', 'out')),
    species    TEXT,
    grade      TEXT,
    thickness  REAL,
    width      REAL,
    length     REAL,
    pieces     INTEGER,
    bundles    INTEGER,
    cubic      REAL,
    unit_price REAL,
    amount     REAL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_order_items_order
    ON order_items (order_type, order_id);

  -- 系统用户（只做登录认证，暂无角色权限）
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
`

const DEFAULT_ADMIN = { username: 'admin', password: 'admin123' }

// 首次初始化时建一个默认管理员（表非空则跳过）
function seedDefaultAdmin() {
  const total = db.prepare(`SELECT COUNT(*) AS total FROM users`).get().total
  if (total > 0) return

  db.prepare(`INSERT INTO users (username, password_hash) VALUES (?, ?)`).run(
    DEFAULT_ADMIN.username,
    bcrypt.hashSync(DEFAULT_ADMIN.password, 10),
  )
  console.log(
    `[users] 已创建默认账号 ${DEFAULT_ADMIN.username} / ${DEFAULT_ADMIN.password}，请尽快修改`,
  )
}

/**
 * 建表（幂等），可重复调用
 *
 * 注意：这里在模块加载时就执行一次。各个路由模块（auth / inbound / outbound / home …）
 * 会在 import 阶段就 prepare 语句，如果那时表还不存在（全新的空数据库，比如容器里
 * 刚挂上的空卷），会直接抛 "no such table: xxx" 让进程在打日志之前就退出。
 * @returns {import('better-sqlite3').Database} db 实例
 */
export function initDB() {
  db.exec(schema)
  seedDefaultAdmin()
  return db
}

initDB()
