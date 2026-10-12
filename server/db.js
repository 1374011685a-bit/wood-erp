import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import bcrypt from 'bcryptjs'
import { writeLog } from './boot-log.js'

const serverDir = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// 数据库文件在模块加载时就要定位，所以这里先把 server/.env 读进来（幂等）
dotenv.config({ path: path.join(serverDir, '.env'), quiet: true })

/**
 * 数据库目录：
 * - 生产（Railway / Sealos）用 DATA_DIR=/data 指向挂载卷
 * - 本地不配 DATA_DIR 时仍落在 server/，沿用现有的 server/data.db
 *
 * 目录不存在会自动创建；不可写（只读卷、权限不足）时自动回退到 server 目录。
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

/**
 * 目录读写探测：能不能建文件、能不能读回、能不能删掉。
 * 不支持的卷在这里就挡下来，避免后面写盘才炸。
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

export const dataDir = resolveDataDir()
writeLog(`[db] 数据目录：${dataDir}`)

// ---------- 加载 sql.js（纯 JS + WebAssembly，完全不碰原生模块 / 文件锁 / mmap） ----------

writeLog('[db] … 正在加载 sql.js（WebAssembly，纯 JS，无原生模块）')
let initSqlJs
try {
  initSqlJs = (await import('sql.js')).default
} catch (err) {
  writeLog(`[启动失败] 加载 sql.js 失败：\n${err?.stack ?? err}`)
  process.exit(1)
}

let wasmDir
let wasmFile
try {
  // sql.js 的入口是 dist/sql-wasm.js，wasm 就在同目录
  wasmDir = path.dirname(require.resolve('sql.js'))
  wasmFile = path.join(wasmDir, 'sql-wasm.wasm')
  writeLog(`[db] sql.js wasm：${wasmFile}`)
  if (!fs.existsSync(wasmFile)) {
    throw new Error('wasm 文件不存在（打包时可能没被拷进镜像）')
  }
} catch (err) {
  writeLog(`[启动失败] 定位 sql.js wasm 失败：${err?.message ?? err}`)
  process.exit(1)
}

let SQL
try {
  SQL = await initSqlJs({ locateFile: (file) => path.join(wasmDir, file) })
  writeLog('[db] ✓ sql.js 初始化完成')
} catch (err) {
  writeLog(`[启动失败] sql.js 初始化失败：\n${err?.stack ?? err}`)
  process.exit(1)
}

// ---------- 决定数据库文件位置 ----------

let activeDir = dataDir
if (!probeDirectory(activeDir)) {
  if (activeDir !== serverDir) {
    writeLog('[警告] /data 卷不支持 SQLite，已回退到容器本地目录（数据不持久）')
    activeDir = serverDir
  }
  if (!probeDirectory(activeDir)) {
    writeLog('[启动失败] 两个目录都无法读写，请检查挂载卷与目录权限')
    process.exit(1)
  }
}

export const dbPath = path.join(activeDir, 'data.db')

// ---------- 从文件载入（sql.js 是内存数据库，需要自己落盘） ----------

writeLog(`[db] 即将打开数据库，路径=${dbPath}`)
let raw
try {
  if (fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) {
    const buffer = fs.readFileSync(dbPath)
    writeLog(`[db] 读取现有数据库文件：${buffer.length} 字节`)
    try {
      raw = new SQL.Database(buffer)
    } catch (err) {
      // 文件损坏（比如上次写盘写了一半）：挪开留档，用新库继续启动
      const backup = `${dbPath}.corrupt-${Date.now()}`
      writeLog(
        `[警告] 现有数据库文件无法解析（${err?.message ?? err}），已备份到 ${backup}，将新建空库`,
      )
      fs.renameSync(dbPath, backup)
      raw = new SQL.Database()
    }
  } else {
    writeLog('[db] 数据库文件不存在，新建空库')
    raw = new SQL.Database()
  }
  writeLog('[db] ✓ 数据库实例已创建')
} catch (err) {
  writeLog(
    `[启动失败] 打开数据库失败：路径=${dbPath}\n` +
      `        code=${err?.code ?? '（无）'}\n` +
      `        message=${err?.message ?? err}\n` +
      `        stack=${err?.stack ?? '（无）'}`,
  )
  process.exit(1)
}

// ---------- 落盘机制：内存库 → 文件 ----------

let inTransaction = false
let pendingPersist = false

function persist(reason) {
  const data = Buffer.from(raw.export())
  const tmpPath = `${dbPath}.tmp-${process.pid}`
  writeLog(`[db] … 落盘中（${reason}）：${data.length} 字节 → ${dbPath}`)

  try {
    // 先写临时文件再改名，避免写一半被中断留下半个库
    fs.writeFileSync(tmpPath, data)
    fs.renameSync(tmpPath, dbPath)
    pendingPersist = false
    writeLog('[db] ✓ 落盘完成')
    return
  } catch (err) {
    writeLog(`[警告] 临时文件改名失败（${err?.message ?? err}），改为直接写入`)
  }

  try {
    fs.writeFileSync(dbPath, data)
    pendingPersist = false
    writeLog('[db] ✓ 落盘完成（直接写入）')
  } catch (err) {
    writeLog(
      `[警告] 落盘失败：${err?.code ?? ''} ${err?.message ?? err}\n` +
        '        数据仍在内存里，但重启会丢失，请检查挂载卷是否可写',
    )
  }
}

function persistIfNeeded(reason) {
  if (inTransaction) {
    pendingPersist = true
    return
  }
  persist(reason)
}

// ---------- 兼容层：把 better-sqlite3 风格的 API 适配到 sql.js ----------

/**
 * 参数适配。
 *
 * sql.js 的具名参数只认「带前缀」的键（`{'@a': 1}`），传普通键名它**不报错，
 * 但会静默绑成 NULL**（实测踩过）。所以这里把具名对象按 SQL 里 @名字 出现的
 * 顺序转成位置参数数组，彻底绕开它的键名规则。
 */
function normalizeParams(params, sql) {
  if (params.length === 0) return []
  if (params.length === 1) {
    const only = params[0]
    if (only === null || only === undefined) return []
    if (Array.isArray(only)) return only
    if (typeof only === 'object') {
      const names = [...sql.matchAll(/[@:$]([A-Za-z_]\w*)/g)].map((m) => m[1])
      return names.map((name) => (name in only ? only[name] : null))
    }
    return [only]
  }
  return params
}

function lastInsertRowid() {
  const stmt = raw.prepare('SELECT last_insert_rowid() AS id')
  try {
    stmt.step()
    return stmt.getAsObject().id
  } finally {
    stmt.free()
  }
}

class Statement {
  constructor(sql) {
    this.sql = sql
  }

  #prepare(params) {
    const stmt = raw.prepare(this.sql)
    const bound = normalizeParams(params, this.sql)
    if (bound.length > 0) stmt.bind(bound)
    return stmt
  }

  /** 取一行（没有返回 undefined） */
  get(...params) {
    const stmt = this.#prepare(params)
    try {
      if (!stmt.step()) return undefined
      return stmt.getAsObject()
    } finally {
      stmt.free()
    }
  }

  /** 取全部行 */
  all(...params) {
    const stmt = this.#prepare(params)
    const rows = []
    try {
      while (stmt.step()) rows.push(stmt.getAsObject())
    } finally {
      stmt.free()
    }
    return rows
  }

  /** 执行写入并立即落盘 */
  run(...params) {
    const stmt = this.#prepare(params)
    try {
      stmt.step()
    } finally {
      stmt.free()
    }
    const changes = raw.getRowsModified()
    const lastId = lastInsertRowid()
    persistIfNeeded('写入后')
    return { changes, lastInsertRowid: lastId }
  }
}

export const db = {
  prepare: (sql) => new Statement(sql),

  exec: (sql) => {
    const result = raw.exec(sql)
    persistIfNeeded('建表/批量执行后')
    return result
  },

  // sql.js 是内存库，没有 WAL / 文件锁概念，保留空实现让上层调用不出错
  pragma: () => undefined,

  transaction: (fn) => (...args) => {
    raw.run('BEGIN')
    inTransaction = true
    try {
      const result = fn(...args)
      raw.run('COMMIT')
      inTransaction = false
      if (pendingPersist) persist('事务提交后')
      return result
    } catch (err) {
      try {
        raw.run('ROLLBACK')
      } catch {
        // 回滚失败也要把原始错误抛出去
      }
      inTransaction = false
      pendingPersist = false
      throw err
    }
  },

  close: () => raw.close(),
}

// ---------- 建表 ----------

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
  writeLog(
    `[users] 已创建默认账号 ${DEFAULT_ADMIN.username} / ${DEFAULT_ADMIN.password}，请尽快修改`,
  )
}

/**
 * 建表（幂等），可重复调用
 *
 * 注意：在模块加载时就执行一次。各个路由模块会在 import 阶段就 prepare 语句，
 * 如果那时表还不存在（全新的空数据库），会直接抛 "no such table" 让进程在打日志之前退出。
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
