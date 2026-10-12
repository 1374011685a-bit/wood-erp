import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import bcrypt from 'bcryptjs'
import { writeLog } from './boot-log.js'

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
        writeLog(
          `[警告] DATA_DIR 不可用（${configured}），已回退到 ${dir}，数据不会持久化，请检查挂载卷`,
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

writeLog(`[db] 数据目录：${dataDir}`)

// better-sqlite3 是原生模块：这里用动态 import，加载失败（架构不匹配、缺 so 文件等）
// 也能打出一行明确日志，而不是静默崩溃
writeLog('[db] … 正在加载 better-sqlite3 原生绑定')
let Database
try {
  Database = (await import('better-sqlite3')).default
  writeLog('[db] ✓ better-sqlite3 原生绑定加载成功')
} catch (err) {
  writeLog(
    `[启动失败] better-sqlite3 原生绑定加载失败（容器架构与镜像架构可能不一致）：\n${err?.stack ?? err}`,
  )
  process.exit(1)
}

/**
 * 打开数据库之前先探测目录：能不能建文件、能不能读回、能不能删掉。
 * 网络卷/只读挂载这类问题在这里就能发现，避免走到 SQLite 原生调用里再出事
 * （原生层如果直接段错误，JS 是接不住的）。
 */
function probeDirectory(dir) {
  const probeFile = path.join(dir, `.write-probe-${process.pid}`)
  try {
    fs.writeFileSync(probeFile, 'probe')
    if (fs.readFileSync(probeFile, 'utf8') !== 'probe') {
      throw new Error('写入后读回内容不一致')
    }
    fs.unlinkSync(probeFile)
    writeLog(`[db] 目录读写探测通过：${dir}`)
    return true
  } catch (err) {
    writeLog(
      `[db] 目录读写探测失败：${dir}\n` +
        `        code=${err?.code ?? '（无）'}\n` +
        `        message=${err?.message ?? err}`,
    )
    try {
      fs.unlinkSync(probeFile)
    } catch {
      // 清理不掉就算了
    }
    return false
  }
}

/**
 * 打开数据库。所有失败都打完整信息（code / message / stack）后返回 null，
 * 交给调用方决定是否换目录重试。
 *
 * 注意：如果原生模块内部是段错误（架构/libc 不匹配）或卡在文件锁上，
 * JS 层 try/catch 是接不住的 —— 那种情况只能靠下面的「换目录重试」绕过。
 */
function openDatabase(targetPath, label) {
  writeLog(`[db] 即将打开数据库，路径=${targetPath}（${label}）`)

  if (!probeDirectory(path.dirname(targetPath))) {
    return null
  }

  try {
    const instance = new Database(targetPath, {
      // 不用 WAL、缺文件就新建、锁等待最多 5 秒后报错而不是无限等
      verbose: null,
      fileMustExist: false,
      timeout: 5000,
    })
    writeLog('[db] 数据库实例已创建')

    // 用兼容性最好的默认回滚日志模式（网络卷/对象存储挂载对 WAL 支持最差）
    try {
      instance.pragma('journal_mode = DELETE')
      writeLog(
        `[db] journal_mode = ${instance.pragma('journal_mode', { simple: true })}`,
      )
    } catch (err) {
      writeLog(`[警告] 设置 journal_mode 失败：${err?.code ?? ''} ${err?.message ?? err}`)
    }

    try {
      instance.pragma('foreign_keys = ON')
    } catch (err) {
      writeLog(`[警告] 开启外键约束失败：${err?.message ?? err}`)
    }

    // 轻量自检：文件损坏时早点说清楚（只记录，不因此退出）
    try {
      const check = instance.pragma('quick_check', { simple: true })
      writeLog(`[db] 完整性自检：${check}`)
    } catch (err) {
      writeLog(`[警告] 完整性自检未能执行：${err?.message ?? err}`)
    }

    return instance
  } catch (err) {
    writeLog(
      `[db] 打开数据库失败：路径=${targetPath}\n` +
        `        code=${err?.code ?? '（无）'}\n` +
        `        message=${err?.message ?? err}\n` +
        `        stack=${err?.stack ?? '（无）'}`,
    )
    return null
  }
}

let activeDbPath = path.join(dataDir, 'data.db')
let dbInstance = openDatabase(activeDbPath, 'DATA_DIR')

// /data 这类网络卷可能根本不支持 SQLite 的文件锁，这里自动回退到容器本地目录重试一次
if (!dbInstance && dataDir !== serverDir) {
  writeLog('[警告] /data 卷不支持 SQLite，已回退到容器本地目录（数据不持久）')
  activeDbPath = path.join(serverDir, 'data.db')
  dbInstance = openDatabase(activeDbPath, '回退到 server 本地目录')
}

if (!dbInstance) {
  writeLog('[启动失败] 两个目录都打不开数据库，请检查挂载卷与目录权限')
  process.exit(1)
}

export const dbPath = activeDbPath
export const db = dbInstance

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
  writeLog('[db] … initDB 开始建表')
  db.exec(schema)
  seedDefaultAdmin()
  writeLog('[db] ✓ initDB 完成')
  return db
}

writeLog('[db] … 模块加载时执行 initDB')
initDB()
