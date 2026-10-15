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
// 附件（合同 PDF 等）跟数据库放同一个目录，挂载卷一致
export const storageDir = activeDir

// ---------- 单实例锁 ----------
//
// 两个后端进程同时对着同一个 data.db 跑，各自都会把「内存里的整库」覆盖回文件，
// 后写的那个会把前一个进程的数据整体抹掉（这个坑真实踩过：一个空库把整份数据盖没了）。
// 所以启动时先抢锁，抢不到就直接退出，绝不碰数据文件。

const lockPath = path.join(activeDir, 'data.db.lock')

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM：进程在，只是没权限发信号
    return err?.code === 'EPERM'
  }
}

function acquireLock() {
  try {
    if (fs.existsSync(lockPath)) {
      let stale = true
      try {
        stale = !pidAlive(Number(JSON.parse(fs.readFileSync(lockPath, 'utf8'))?.pid))
      } catch {
        stale = true // 锁文件坏了，当过期处理
      }

      if (!stale) {
        writeLog(
          `[启动失败] 数据库正被另一个后端进程占用：${lockPath}\n` +
            '        同一个 data.db 不能让两个进程同时打开，否则会互相覆盖、丢数据。\n' +
            '        请先停掉已经在运行的后端（确认 3001 端口没被占用），再重新启动。',
        )
        process.exit(1)
      }

      writeLog('[警告] 发现上次遗留的锁文件（所属进程已退出），继续启动')
    }

    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    )

    const release = () => {
      try {
        fs.unlinkSync(lockPath)
      } catch {
        // 已经没了就算了
      }
    }
    process.on('exit', release)
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => {
        release()
        process.exit(0)
      })
    }

    writeLog(`[db] ✓ 已取得数据库独占锁：${lockPath}`)
  } catch (err) {
    // 锁机制本身出问题不该挡住启动，但必须说清楚
    writeLog(
      `[警告] 单实例锁创建失败（${err?.code ?? ''} ${err?.message ?? err}），继续启动`,
    )
  }
}

acquireLock()

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
    // 覆盖前把上一版留一份，万一盖错了还能人工找回
    if (fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) {
      fs.copyFileSync(dbPath, `${dbPath}.bak`)
    }
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
    brand      TEXT,
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

  -- 库存归组（品名+等级+尺寸）与「取该规格最近入库单价」的子查询共用这一组列
  CREATE INDEX IF NOT EXISTS idx_items_spec
    ON order_items (order_type, species, grade, thickness, width, length, id);

  -- 流水按时间倒序翻页
  CREATE INDEX IF NOT EXISTS idx_items_created
    ON order_items (created_at, id);

  -- 单据按日期筛选、按创建时间排序
  CREATE INDEX IF NOT EXISTS idx_inbound_date    ON inbound_orders  (order_date);
  CREATE INDEX IF NOT EXISTS idx_outbound_date   ON outbound_orders (order_date);
  CREATE INDEX IF NOT EXISTS idx_inbound_created ON inbound_orders  (created_at);
  CREATE INDEX IF NOT EXISTS idx_outbound_created ON outbound_orders (created_at);

  -- 盘点单头
  CREATE TABLE IF NOT EXISTS stock_counts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    count_no     TEXT    NOT NULL UNIQUE,
    count_date   TEXT,
    remark       TEXT,
    item_count   INTEGER NOT NULL DEFAULT 0,
    diff_cubic   REAL    NOT NULL DEFAULT 0,
    in_order_no  TEXT,
    out_order_no TEXT,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  -- 盘点明细：账面 / 实盘 / 差异，留档可追溯
  CREATE TABLE IF NOT EXISTS stock_count_items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    count_id         INTEGER NOT NULL,
    species          TEXT,
    grade            TEXT,
    thickness        REAL,
    width            REAL,
    length           REAL,
    pieces           REAL,
    book_bundles     INTEGER NOT NULL DEFAULT 0,
    book_cubic       REAL    NOT NULL DEFAULT 0,
    actual_bundles   INTEGER NOT NULL DEFAULT 0,
    diff_bundles     INTEGER NOT NULL DEFAULT 0,
    diff_cubic       REAL    NOT NULL DEFAULT 0,
    unit_price       REAL    NOT NULL DEFAULT 0,
    unit_price_cents INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_count_items_count ON stock_count_items (count_id);

  -- 收付款记录（对账用）
  -- side=customer：客户付给我们的收款（冲应收）
  -- side=supplier：我们付给供应商的付款（冲应付）
  CREATE TABLE IF NOT EXISTS payments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_no   TEXT    NOT NULL UNIQUE,
    side         TEXT    NOT NULL CHECK (side IN ('customer', 'supplier')),
    partner      TEXT    NOT NULL,
    amount_cents INTEGER NOT NULL,
    pay_date     TEXT,
    method       TEXT,
    remark       TEXT,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_payments_partner
    ON payments (side, partner, pay_date, id);
  CREATE INDEX IF NOT EXISTS idx_payments_date ON payments (pay_date);

  -- 合同（PDF 存在数据目录的 uploads/contracts 下，库里只存元信息）
  CREATE TABLE IF NOT EXISTS contracts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_no   TEXT    NOT NULL UNIQUE,
    title         TEXT,
    partner       TEXT,
    sign_date     TEXT,
    amount_cents  INTEGER NOT NULL DEFAULT 0,
    remark        TEXT,
    file_name     TEXT,
    file_original TEXT,
    file_size     INTEGER NOT NULL DEFAULT 0,
    deleted_at    TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_contracts_no ON contracts (contract_no);
  CREATE INDEX IF NOT EXISTS idx_contracts_partner ON contracts (partner);

  -- 提单：一个合同可能分几票发运，一票提单覆盖多个柜
  CREATE TABLE IF NOT EXISTS shipments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    bl_no         TEXT    NOT NULL UNIQUE,
    contract_no   TEXT,
    supplier      TEXT,
    arrival_date  TEXT,
    remark        TEXT,
    deleted_at    TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_shipments_contract ON shipments (contract_no);

  -- 柜（挂在提单下面；contract_no / bl_no 是从提单带下来的一份副本，方便查询）
  CREATE TABLE IF NOT EXISTS containers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    container_no TEXT    NOT NULL UNIQUE,
    shipment_id  INTEGER,
    contract_no  TEXT,
    bl_no        TEXT,
    supplier     TEXT,
    arrive_date  TEXT,
    remark       TEXT,
    deleted_at   TEXT,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_containers_contract ON containers (contract_no);

  -- 码单：一包一个，贴在包上；入库时生成，出库时按码单发货
  CREATE TABLE IF NOT EXISTS bales (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    bale_no           TEXT    NOT NULL UNIQUE,
    container_id      INTEGER,
    inbound_order_id  INTEGER,
    outbound_order_id INTEGER,
    species           TEXT,
    grade             TEXT,
    thickness         REAL,
    width             REAL,
    length            REAL,
    pieces            INTEGER,
    cubic             REAL,
    status            TEXT    NOT NULL DEFAULT 'in_stock',
    created_at        TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    shipped_at        TEXT
  );

  -- 包里的规格行：一包可能混装多个规格，所以规格放在子表
  CREATE TABLE IF NOT EXISTS bale_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    bale_id     INTEGER NOT NULL,
    brand       TEXT,
    species     TEXT,
    grade       TEXT,
    thickness   REAL,
    width       REAL,
    length      REAL,
    pieces      INTEGER,
    cubic       REAL
  );

  CREATE INDEX IF NOT EXISTS idx_bale_items_bale ON bale_items (bale_id);

  -- 常用项字典：常用的品名（木材名称）和等级，录单时直接选，不用每次手打
  CREATE TABLE IF NOT EXISTS dict_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_dict_kind_name ON dict_items (kind, name);

  CREATE INDEX IF NOT EXISTS idx_bales_container ON bales (container_id);
  CREATE INDEX IF NOT EXISTS idx_bales_status    ON bales (status, id);
  CREATE INDEX IF NOT EXISTS idx_bales_inbound   ON bales (inbound_order_id);
  CREATE INDEX IF NOT EXISTS idx_bales_outbound  ON bales (outbound_order_id);

  -- 入库单上的提单号
  -- （合同号那一列在 migrateOrderFields 里加，和操作员/仓库一起）

  -- 系统用户：登录认证 + 角色权限
  --   role          角色（admin/finance/sales/warehouse/viewer），见 server/permissions.js
  --   active        停用开关：1 正常，0 停用（停用后连登录都不让过）
  --   token_version 改密码 / 停用 / 改角色时自增，用来立刻作废旧 token
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'viewer',
    active        INTEGER NOT NULL DEFAULT 1,
    token_version INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  -- 改包记录：把一包货的规格改掉，留下改前 / 改后 / 损耗，方便对账和回溯
  CREATE TABLE IF NOT EXISTS repacks (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    repack_no           TEXT    NOT NULL UNIQUE,
    repack_date         TEXT    NOT NULL,
    bale_id             INTEGER,
    barcode             TEXT,
    bale_no             TEXT,
    container_no        TEXT,
    summary             TEXT,
    remark              TEXT,
    before_cubic        REAL    NOT NULL DEFAULT 0,
    before_amount_cents INTEGER NOT NULL DEFAULT 0,
    after_cubic         REAL    NOT NULL DEFAULT 0,
    after_amount_cents  INTEGER NOT NULL DEFAULT 0,
    loss_cubic          REAL    NOT NULL DEFAULT 0,
    price_pinned        INTEGER NOT NULL DEFAULT 0,
    before_json         TEXT,
    after_json          TEXT,
    bl_no               TEXT,
    contract_no         TEXT,
    -- 改包的两条路：'spec' = 改这一包的规格（包还在）；'split' = 把一包拆成几包（原包删掉）
    kind                TEXT    NOT NULL DEFAULT 'spec',
    -- 拆包拆出来的新包 id（JSON 数组），撤回时按它找
    after_bale_ids      TEXT,
    -- 原包整行快照，撤回时用来把原包原样重建回来
    before_bale_json    TEXT,
    created_at          TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_repacks_date ON repacks (repack_date, id);

  -- 采购合同的明细：只记「定了什么货」——品牌/品名/等级/数量/单价/金额，不记长宽高
  CREATE TABLE IF NOT EXISTS contract_items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id      INTEGER NOT NULL,
    brand            TEXT,
    species          TEXT,
    grade            TEXT,
    quantity         REAL    NOT NULL DEFAULT 0,
    unit_price_cents INTEGER NOT NULL DEFAULT 0,
    amount_cents     INTEGER NOT NULL DEFAULT 0,
    remark           TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_contract_items_contract ON contract_items (contract_id);
`

const DEFAULT_ADMIN = { username: 'admin', password: 'admin123' }

/** 表里有没有这一列（给可重复执行的加列迁移用） */
function hasColumn(table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column)
}

function addColumnIfMissing(table, column, definition) {
  if (hasColumn(table, column)) return false
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  writeLog(`[db] 迁移：${table} 新增列 ${column} ${definition}`)
  return true
}

/**
 * 金额改为「整数分」。
 *
 * 浮点金额在按客户/规格做汇总核对时会累积误差（0.1 + 0.2 那类问题），所以新增
 * unit_price_cents / amount_cents 整数列作为金额的唯一真相：写入时算分、汇总时
 * 把分相加，只在接口输出时除以 100。老的 unit_price / amount 保留为显示镜像，
 * 写入时一起维护，读的地方不用全部改写。
 */
function migrateMoneyToCents() {
  const addedPrice = addColumnIfMissing('order_items', 'unit_price_cents', 'INTEGER')
  const addedAmount = addColumnIfMissing('order_items', 'amount_cents', 'INTEGER')
  if (!addedPrice && !addedAmount) return

  const result = db
    .prepare(
      `UPDATE order_items
          SET unit_price_cents = CAST(ROUND(COALESCE(unit_price, 0) * 100) AS INTEGER),
              amount_cents     = CAST(ROUND(COALESCE(amount, 0) * 100) AS INTEGER)
        WHERE unit_price_cents IS NULL OR amount_cents IS NULL`,
    )
    .run()
  writeLog(`[db] 迁移：金额转整数分，已回填 ${result.changes} 行`)
}

/**
 * 软删除标记。
 *
 * 删除单据时不再物理删行，只打一个 deleted_at 时间戳；明细同样打标。
 * 所有汇总查询都会带上 `deleted_at IS NULL`，所以删掉的单据自动退出库存、
 * 流水、首页和导出，但可以整单恢复（回收站）。
 * 单号不能被复用，所以生成新单号时故意**不**过滤已删除的单据。
 */
function migrateSoftDelete() {
  const targets = [
    ['inbound_orders', 'deleted_at', 'TEXT'],
    ['outbound_orders', 'deleted_at', 'TEXT'],
    ['order_items', 'deleted_at', 'TEXT'],
    ['stock_counts', 'deleted_at', 'TEXT'],
  ]

  const added = targets.filter(([table, column, type]) =>
    addColumnIfMissing(table, column, type),
  )
  if (added.length > 0) {
    writeLog('[db] 迁移：单据与明细新增软删除标记 deleted_at')
  }

  // 明细表按「未删除」过滤是最高频的访问路径，顺手加一个部分索引
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_items_live
       ON order_items (order_type, species, grade, thickness, width, length, id)
     WHERE deleted_at IS NULL`,
  )
}

/**
 * 单据头补充「仓库 / 操作员」。
 * 仓库必填（哪批货进哪个仓），操作员选填（谁经手）。
 * 老单据这两列是 NULL，读的地方按空值兜底。
 */
function migrateOrderFields() {
  const targets = [
    ['inbound_orders', 'warehouse', 'TEXT'],
    ['inbound_orders', 'operator', 'TEXT'],
    ['inbound_orders', 'bl_no', 'TEXT'],
    ['inbound_orders', 'contract_no', 'TEXT'],
    ['inbound_orders', 'container_id', 'INTEGER'],
    ['containers', 'shipment_id', 'INTEGER'],
    ['outbound_orders', 'warehouse', 'TEXT'],
    ['outbound_orders', 'operator', 'TEXT'],
  ]

  const added = targets.filter(([table, column, type]) =>
    addColumnIfMissing(table, column, type),
  )
  if (added.length > 0) {
    writeLog(
      '[db] 迁移：单据头新增 仓库 / 操作员 / 提单号(bl_no) / 合同号(contract_no)',
    )
  }

  // 索引要等列加完再建（老库升级时 shipment_id 是后来加的）
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_containers_shipment ON containers (shipment_id)`,
  )
}

/**
 * 码单上的「条码号」：和手填的包号分开。
 *
 * - 包号（bale_no）= 工人手打，对应货上写的那个包号；
 * - 条码号（barcode）= 系统按柜内顺序生成，就是要打印出来贴包上的那张码。
 *
 * 老数据没有条码号，先用原来的包号补上，之后新录的都走生成规则。
 */
function migrateBaleBarcode() {
  const added = addColumnIfMissing('bales', 'barcode', 'TEXT')
  db.exec(
    `UPDATE bales SET barcode = bale_no WHERE barcode IS NULL OR barcode = ''`,
  )
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bales_barcode ON bales (barcode)`)
  if (added) writeLog('[db] 迁移：码单新增列 barcode（条码号），老数据用包号补上')
}

/** 单据上的「车号」（选填，来车拉货时记一下） */
function migrateVehicleNo() {
  const added = [
    addColumnIfMissing('inbound_orders', 'vehicle_no', 'TEXT'),
    addColumnIfMissing('outbound_orders', 'vehicle_no', 'TEXT'),
  ].filter(Boolean)
  if (added.length > 0) writeLog('[db] 迁移：单据新增列 vehicle_no（车号）')
}

/** 柜号：一包货装在哪个柜/柜里，工人手填，单据上自动统计柜数 */
function migrateBoxNo() {
  const added = [
    addColumnIfMissing('bales', 'box_no', 'TEXT'),
    addColumnIfMissing('order_items', 'box_no', 'TEXT'),
  ].filter(Boolean)
  if (added.length > 0) writeLog('[db] 迁移：包与明细新增列 box_no（柜号）')
}

/**
 * 品牌：入库明细和包里的规格行各记一份。
 *
 * 只存不参与匹配——库存归组仍然是「品名 + 等级 + 尺寸」，
 * 改包取原行价格也仍然按「品名 + 等级 + 规格 + 片数」匹配。
 * 老数据留空，前端显示成「—」。
 */
function migrateBrand() {
  const added = [
    addColumnIfMissing('order_items', 'brand', 'TEXT'),
    addColumnIfMissing('bale_items', 'brand', 'TEXT'),
  ].filter(Boolean)
  if (added.length > 0) writeLog('[db] 迁移：明细与规格行新增列 brand（品牌）')
}

/**
 * 包支持软删：删入库单时不再真删包，只打 deleted_at 标记。
 * 这样从回收站恢复单据时，包、码单号、规格行能一起回来（以前回来的是空单）。
 */
function migrateRepackCreator() {
  const added = addColumnIfMissing('repacks', 'created_by', 'TEXT')
  if (added) writeLog('[db] 迁移：改包记录新增列 created_by（制单人）')
}

/**
 * 用户角色与登录态控制。
 *
 * - role：角色。默认给 'viewer'（最小权限）—— 万一将来有人直接写 SQL 建了个用户，
 *   他拿到的是「只读」，不会因为忘了设角色而白得写权限。
 * - active：停用开关。管理员「停用账号」而不是删账号，created_by 那些审计字段还能追溯。
 * - token_version：改密码 / 停用 / 改角色时自增，用来把已经发出去的 token 一键作废。
 *   没有它就等于「停用了还要等他手上的令牌过期（7 天）」，等于没停用。
 *
 * 迁移完把已有的 admin 账号提成管理员（老库升级时它现在是默认角色）。
 */
function migrateUserRoles() {
  const added = [
    addColumnIfMissing('users', 'role', "TEXT NOT NULL DEFAULT 'viewer'"),
    addColumnIfMissing('users', 'active', 'INTEGER NOT NULL DEFAULT 1'),
    addColumnIfMissing('users', 'token_version', 'INTEGER NOT NULL DEFAULT 0'),
  ].filter(Boolean)
  if (added.length > 0) {
    writeLog('[db] 迁移：用户表新增 role / active / token_version')
  }

  // 已有库里的 admin 一定是管理员（新库里 seedDefaultAdmin 也会带上这个角色）
  const promoted = db
    .prepare(
      `UPDATE users SET role = 'admin'
        WHERE username = ? AND role <> 'admin'`,
    )
    .run(DEFAULT_ADMIN.username)
  if (promoted.changes > 0) {
    writeLog(`[db] 迁移：账号 ${DEFAULT_ADMIN.username} 已设为管理员`)
  }
}

/**
 * 改包支持「拆包」。
 *
 * 以前改包只能改**同一包**的规格；现在要把一包混装货拆成几包，就得记下
 * 「拆出来的是哪几包」和「原包长什么样」——原包会被真删掉，撤回时只能靠快照重建。
 *
 * - kind：'spec' 改规格（老行为）/ 'split' 拆包
 * - after_bale_ids：拆出来的新包 id（JSON 数组）
 * - before_bale_json：原包整行快照（包号 / 条码号 / 柜号 / 提单 / 入库单 / 状态）
 *
 * 老记录 kind 默认 'spec'，行为和以前完全一样。
 */
function migrateRepackSplit() {
  const added = [
    addColumnIfMissing('repacks', 'kind', "TEXT NOT NULL DEFAULT 'spec'"),
    addColumnIfMissing('repacks', 'after_bale_ids', 'TEXT'),
    addColumnIfMissing('repacks', 'before_bale_json', 'TEXT'),
  ].filter(Boolean)
  if (added.length > 0) {
    writeLog('[db] 迁移：改包记录新增 kind / after_bale_ids / before_bale_json（支持拆包）')
  }
}

/**
 * 包号：**全局唯一**，空包号除外。
 *
 * 规则（用户确认）：
 *   - 有值的包号，整个系统里只能出现一次 —— 跨提单、跨柜、跨一切
 *   - 空包号随便有几个，不参与唯一性（所以要用部分索引）
 *   - **软删的包不算**（进回收站的单，它的包号要立刻腾出来给人用）：
 *     不然会出现「列表里查重说这个号没人用 → 插库时撞索引」的原始 SQLite 报错，
 *     而用户根本看不出那个号躺在回收站里（deleted_at IS NOT NULL）。
 *
 * 历史：最早是 `UNIQUE(bale_no)`（全局、连空值也管），后来改过一版
 * 「提单内唯一」的 `idx_bales_scope_no`。这一版把它彻底换成全局的
 * `idx_bales_no_global`，所以要把旧索引删掉 —— 否则老索引还在，
 * 同一张提单里重名照样会被它拦，跨提单重名又拦不住，两套规则打架。
 *
 * 口径必须和 `assertBaleNoAvailable` / `preflightBales` 的查重 SQL 一致
 * （那两句都带 `deleted_at IS NULL`）—— 索引是最后一关，两边不一致就会
 * 变成「查重放过、插库报错」。
 */
function migrateBaleNoGlobalUnique() {
  db.exec(`DROP INDEX IF EXISTS idx_bales_scope_no`)
  const wanted = `CREATE UNIQUE INDEX idx_bales_no_global
       ON bales (bale_no)
     WHERE bale_no IS NOT NULL AND bale_no <> '' AND deleted_at IS NULL`
  /**
   * `CREATE ... IF NOT EXISTS` 不会更新已存在的索引，所以先看口径对不对：
   * 老库里可能还留着「没排除软删」的那版（正是用户踩到的坑），这里顺手重建。
   */
  const current = db
    .prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_bales_no_global'`)
    .get()?.sql
  const upToDate = current && /deleted_at\s+IS\s+NULL/i.test(current)
  if (!upToDate) {
    db.exec(`DROP INDEX IF EXISTS idx_bales_no_global`)
    db.exec(wanted)
    if (current) writeLog('[db] 迁移：重建包号全局唯一索引（口径改为「软删的不算」）')
  }
}

/**
 * 提单号：查重口径「大小写不敏感 + 去空格」，并且**软删的不占号**。
 *
 * 1) 存量里带空格的号统一去空格（`'X '` → `'X'`），否则拿 `'X'` 永远查不到它，
 *    同一票货就会建出第二张提单；
 * 2) 加表达式唯一索引 `lower(trim(bl_no)) WHERE deleted_at IS NULL` ——
 *    表上原有的只是列的 `UNIQUE(bl_no)`（精确匹配），`'ABC'` 和 `'abc'` 能并存；
 * 3) 建索引前先自检非软删的重号：确实有（只是大小写 / 空格不同）就**不建唯一索引**，
 *    打日志列出来让人先合并，避免启动直接失败；这时退化成普通索引，查询不会变慢。
 */
/**
 * 提单号：把建表时写死的那句列级 `UNIQUE(bl_no)` 拆掉。
 *
 * 它是**精确匹配**的唯一约束，而且**连软删的行也占着号** ——
 * 把一张提单删进回收站后，用同一个号（连大小写都一样）再建，
 * 会直接报 `UNIQUE constraint failed: shipments.bl_no`。
 * SQLite 删不掉列上的约束，只能重建表：建新表 → 搬数据 → 删旧表 → 改名。
 * 唯一性改由 `migrateShipmentBlNoUnique()` 建的部分索引负责
 * （大小写不敏感 + 去空格 + 排除软删），那个函数跑在这个**之后**。
 */
function migrateShipmentDropInlineUnique() {
  const tableSql =
    db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='shipments'`)
      .get()?.sql ?? ''
  if (!/bl_no\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(tableSql)) return

  db.exec(`
    CREATE TABLE shipments_new (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      bl_no         TEXT    NOT NULL,
      contract_no   TEXT,
      supplier      TEXT,
      arrival_date  TEXT,
      remark        TEXT,
      deleted_at    TEXT,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    INSERT INTO shipments_new
      (id, bl_no, contract_no, supplier, arrival_date, remark, deleted_at, created_at)
      SELECT id, trim(bl_no), contract_no, supplier, arrival_date, remark, deleted_at, created_at
        FROM shipments;
    DROP TABLE shipments;
    ALTER TABLE shipments_new RENAME TO shipments;
    CREATE INDEX IF NOT EXISTS idx_shipments_contract ON shipments (contract_no);
  `)
  writeLog(
    '[db] 迁移：重建 shipments 表（去掉列级 UNIQUE，改用「大小写不敏感 + 去空格 + 软删不占号」的唯一索引）',
  )
}

function migrateShipmentBlNoUnique() {
  // 先确保表上没有「列级 UNIQUE」—— 它连软删的行也占着号（见上一个迁移）
  const trimmed = db
    .prepare(`UPDATE shipments SET bl_no = trim(bl_no) WHERE trim(bl_no) <> bl_no`)
    .run()

  const dupes = db
    .prepare(
      `SELECT lower(trim(bl_no)) AS key, COUNT(*) AS n, group_concat(id) AS ids
         FROM shipments
        WHERE deleted_at IS NULL
        GROUP BY lower(trim(bl_no))
       HAVING COUNT(*) > 1`,
    )
    .all()

  if (dupes.length > 0) {
    writeLog(`[db] ⚠️ 提单号有 ${dupes.length} 组重号（只是大小写 / 空格不同），本次不建唯一索引：`)
    for (const one of dupes) writeLog(`       「${one.key}」→ id ${one.ids}`)
    writeLog('[db]       合并这些提单后重启，会自动补上唯一索引')
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_shipments_bl_no_lookup ON shipments (lower(trim(bl_no)))`,
    )
    return
  }

  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_shipments_bl_no'`)
    .get()
  if (exists) return

  db.exec(
    `CREATE UNIQUE INDEX idx_shipments_bl_no
       ON shipments (lower(trim(bl_no)))
     WHERE deleted_at IS NULL`,
  )
  writeLog(
    '[db] 迁移：提单号唯一索引（大小写不敏感 + 去空格，软删不占号）' +
      (trimmed.changes > 0 ? `；顺手去空格 ${trimmed.changes} 行` : ''),
  )
}

/**
 * 合同号：和提单号同一个坑 —— 表上是列级 `UNIQUE(contract_no)`（精确匹配），
 * 它连**软删**的行也占着号；而应用层查重（contracts.js 的新建 / 编辑两处）
 * 是带 `deleted_at IS NULL` 的。两边口径不一致，结果就是：
 *   查重说「这个号没人用」→ 插库撞唯一约束 → 报「合同号 X 已存在」，
 *   用户拿着一个明明已经删掉的号，怎么都建不回来。
 *
 * 列级 UNIQUE 生成的是 `sqlite_autoindex_*`，**不能 DROP**
 * （`index associated with UNIQUE or PRIMARY KEY constraint cannot be dropped`），
 * 所以只能重建表 —— 和 `migrateShipmentDropInlineUnique` 一模一样的做法。
 *
 * 合同是按**号（字符串）**关联的，不是按 id：`inbound_orders.contract_no`、
 * `shipments.contract_no`、`containers.contract_no` 都存的是号，所以重建表
 * 只要把 `contract_no` 的值原样搬过去，这些地方都不用动。
 */
function migrateContractDropInlineUnique() {
  const tableSql =
    db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='contracts'`)
      .get()?.sql ?? ''
  if (!/contract_no\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(tableSql)) return

  db.exec(`
    CREATE TABLE contracts_new (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_no   TEXT    NOT NULL,
      title         TEXT,
      partner       TEXT,
      sign_date     TEXT,
      amount_cents  INTEGER NOT NULL DEFAULT 0,
      remark        TEXT,
      file_name     TEXT,
      file_original TEXT,
      file_size     INTEGER NOT NULL DEFAULT 0,
      deleted_at    TEXT,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    INSERT INTO contracts_new
      (id, contract_no, title, partner, sign_date, amount_cents, remark,
       file_name, file_original, file_size, deleted_at, created_at)
      SELECT id, trim(contract_no), title, partner, sign_date, amount_cents, remark,
             file_name, file_original, file_size, deleted_at, created_at
        FROM contracts;
    DROP TABLE contracts;
    ALTER TABLE contracts_new RENAME TO contracts;
    CREATE INDEX IF NOT EXISTS idx_contracts_no ON contracts (contract_no);
    CREATE INDEX IF NOT EXISTS idx_contracts_partner ON contracts (partner);
  `)
  writeLog(
    '[db] 迁移：重建 contracts 表（去掉列级 UNIQUE，改用「大小写不敏感 + 去空格 + 软删不占号」的唯一索引）',
  )
}

/**
 * 合同号唯一索引：`lower(trim(contract_no)) WHERE deleted_at IS NULL`。
 *
 * 口径和 `migrateShipmentBlNoUnique` 完全一致：
 *   1) 先把存量号两边的空格去掉（`'A11 '` → `'A11'`），不然按 `'A11'` 查会查不到它；
 *   2) 自检非软删的重号 —— 确实有（只是大小写 / 空格不同）就**不建唯一索引**，
 *      打日志列出来让人先合并，避免启动直接失败；这时退化成普通索引，查询不会变慢。
 *
 * 口径必须和 `contracts.js` 的查重 SQL 一致（那两处都带 `deleted_at IS NULL`），
 * 否则又会变成「查重放过、插库报错」这一对。
 */
function migrateContractNoUnique() {
  // 先确保表上没有「列级 UNIQUE」—— 它连软删的行也占着号（见上一个迁移）
  const trimmed = db
    .prepare(
      `UPDATE contracts SET contract_no = trim(contract_no)
        WHERE trim(contract_no) <> contract_no`,
    )
    .run()

  const dupes = db
    .prepare(
      `SELECT lower(trim(contract_no)) AS key, COUNT(*) AS n, group_concat(id) AS ids
         FROM contracts
        WHERE deleted_at IS NULL
        GROUP BY lower(trim(contract_no))
       HAVING COUNT(*) > 1`,
    )
    .all()

  if (dupes.length > 0) {
    writeLog(`[db] ⚠️ 合同号有 ${dupes.length} 组重号（只是大小写 / 空格不同），本次不建唯一索引：`)
    for (const one of dupes) writeLog(`       「${one.key}」→ id ${one.ids}`)
    writeLog('[db]       合并这些合同后重启，会自动补上唯一索引')
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_contracts_no_lookup ON contracts (lower(trim(contract_no)))`,
    )
    return
  }

  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_contracts_no_global'`)
    .get()
  if (exists) return

  db.exec(
    `CREATE UNIQUE INDEX idx_contracts_no_global
       ON contracts (lower(trim(contract_no)))
     WHERE deleted_at IS NULL`,
  )
  writeLog(
    '[db] 迁移：合同号唯一索引（大小写不敏感 + 去空格，软删不占号）' +
      (trimmed.changes > 0 ? `；顺手去空格 ${trimmed.changes} 行` : ''),
  )
}

function migrateBaleSoftDelete() {
  const added = addColumnIfMissing('bales', 'deleted_at', 'TEXT')
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bales_deleted ON bales (deleted_at)`)
  if (added) writeLog('[db] 迁移：包新增列 deleted_at（删单据时随单软删，可随回收站恢复）')
}

/**
 * 规格行记住自己来自哪张入库单：`bale_items.src_inbound_order_id`。
 *
 * 为什么需要：包是**物理**的东西，可以随便重组（多包并成一包、一包拆成几包），
 * 但财务账（order_items）必须按来源各记各的 —— 一包里混了两张单的货时，
 * 「扣库存 / 挂库存」要分别落到各自那张单上，不能因为合并就把账挪走。
 * 有了这一列，`detachBaleFromOrder` / `attachBaleToOrder` 才能按行分组处理。
 *
 * 老数据回填：这一行属于哪张单 = 它所在包的 `bales.inbound_order_id`
 * （包和规格行本来就是在这个口径下写出来的，回填不会改变任何金额）。
 */
function migrateBaleItemSourceOrder() {
  const added = addColumnIfMissing('bale_items', 'src_inbound_order_id', 'INTEGER')
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_bale_items_src_order
       ON bale_items (src_inbound_order_id)`,
  )
  if (!added) return

  const filled = db
    .prepare(
      `UPDATE bale_items
          SET src_inbound_order_id = (
                SELECT b.inbound_order_id FROM bales b WHERE b.id = bale_items.bale_id
              )
        WHERE src_inbound_order_id IS NULL`,
    )
    .run()
  writeLog(
    `[db] 迁移：规格行新增列 src_inbound_order_id（这一行来自哪张入库单），回填 ${filled.changes} 行`,
  )
}

/**
 * 明细行记住自己那一行的包号：order_items.bale_no。
 *
 * 为什么需要：包号只存在 bales 上，编辑入库单时只能按「规格+片数」去猜哪行对应哪些包，
 * 同一单里两行规格一样就分不清了。把包号落到明细行上，编辑时就能精确读回。
 *
 * 老数据回填规则（保守）：
 *   - 按「规格 + 片数」找到的包数 = 这行的件数 → 全部填上（能对上）
 *   - 只找到 1 个包 → 也填上
 *   - 其它（0 个 或 数量对不上）→ 留空并打印，等人工处理
 */
function migrateOrderItemBaleNo() {
  const added = addColumnIfMissing('order_items', 'bale_no', 'TEXT')
  if (!added) return

  const items = db
    .prepare(
      `SELECT id, order_id, species, grade, thickness, width, length, pieces, bundles
         FROM order_items
        WHERE order_type = 'in' AND deleted_at IS NULL AND (bale_no IS NULL OR bale_no = '')`,
    )
    .all()
  const balesOfOrder = db.prepare(
    `SELECT bale_no FROM bales
      WHERE inbound_order_id = ? AND deleted_at IS NULL
        AND COALESCE(species, '') = COALESCE(?, '')
        AND COALESCE(grade, '') = COALESCE(?, '')
        AND thickness = ? AND width = ? AND length = ? AND pieces = ?
      ORDER BY id`,
  )
  const fill = db.prepare(`UPDATE order_items SET bale_no = ? WHERE id = ?`)

  let filled = 0
  const unresolved = []
  for (const item of items) {
    const matches = balesOfOrder
      .all(item.order_id, item.species, item.grade, item.thickness, item.width, item.length, item.pieces)
      .map((row) => row.bale_no)
    const bundles = Number(item.bundles ?? 0)
    if (matches.length === 1 || matches.length === bundles) {
      fill.run(matches.join('、'), item.id)
      filled += 1
    } else {
      unresolved.push(
        `明细 id=${item.id}（单 ${item.order_id} ${item.species} ${item.thickness}×${item.width}×${item.length} ${item.pieces}片 ${bundles}件）：找到 ${matches.length} 个包`,
      )
    }
  }
  writeLog(`[db] 迁移：明细新增列 bale_no（这行的包号），回填 ${filled} 行`)
  if (unresolved.length > 0) {
    writeLog(
      `[db] 警告：有 ${unresolved.length} 行明细的包号回填不了（老数据同规格多行分不清），需要人工确认：\n        ` +
        unresolved.join('\n        '),
    )
  }
}

/**
 * 规格行记住自己那一行的成本单价。
 *
 * 为什么必须存：改包 / 编辑码单时，入库明细是「扣掉再挂回」重建的。
 * 如果单价靠「该规格最近入库价」重新猜，同一单里同规格、不同片数的行就会串价，
 * 金额会在用户不知情的情况下变——财务字段不能这样。
 * 老数据按「规格 + 片数」去入库明细里把当时的价格补上。
 */
function migrateBaleItemPrice() {
  const added = addColumnIfMissing('bale_items', 'unit_price_cents', 'INTEGER')
  if (!added) return

  const filled = db
    .prepare(
      `UPDATE bale_items
          SET unit_price_cents = (
                SELECT COALESCE(oi.unit_price_cents, ROUND(oi.unit_price * 100))
                  FROM bales b
                  JOIN order_items oi
                    ON oi.order_type = 'in'
                   AND oi.order_id = b.inbound_order_id
                   AND oi.deleted_at IS NULL
                   AND COALESCE(oi.species, '') = COALESCE(bale_items.species, '')
                   AND COALESCE(oi.grade, '') = COALESCE(bale_items.grade, '')
                   AND oi.thickness = bale_items.thickness
                   AND oi.width = bale_items.width
                   AND oi.length = bale_items.length
                   AND oi.pieces = bale_items.pieces
                 WHERE b.id = bale_items.bale_id
                 LIMIT 1
              )
        WHERE unit_price_cents IS NULL`,
    )
    .run()
  writeLog(
    `[db] 迁移：规格行新增列 unit_price_cents（每行记住自己的单价），回填 ${filled.changes} 行`,
  )
}

/**
 * 包号的唯一范围改一下：
 *
 * - 以前建表时写的是 UNIQUE(bale_no) —— 全局唯一，两票货不能有同名包号；
 * - 现在改成「提单内唯一」；没提单的散货按「入库单内唯一」，不同票可以重号。
 *
 * SQLite 删不掉已有的 UNIQUE 约束，只能重建表：建新表 → 搬数据 → 删旧表 → 改名。
 * 顺手做一个兜底：万一有重复，保留最新那条，旧的删掉并打印出来。
 */
function migrateBaleScope() {
  const tableSql =
    db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='bales'`).get()
      ?.sql ?? ''
  const needRebuild =
    !hasColumn('bales', 'scope_key') ||
    /bale_no\s+TEXT\s+NOT NULL\s+UNIQUE/i.test(tableSql)

  /**
   * 已经改好的库不用重建表，直接返回。
   *
   * 注意：包号的唯一索引**不在这里建** —— 它已经升级成「全局唯一」，
   * 由 migrateBaleNoGlobalUnique() 负责（这个函数跑在它后面，
   * 这里要是再建一次提单内的老索引，两套规则就打架了）。
   */
  if (!needRebuild) {
    return
  }

  const rows = db.prepare(`SELECT * FROM bales`).all()
  const scopeOf = (row) =>
    row.shipment_id
      ? `bl:${row.shipment_id}`
      : row.inbound_order_id
        ? `order:${row.inbound_order_id}`
        : `bale:${row.id}`

  db.exec(`
    CREATE TABLE bales_new (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      bale_no           TEXT    NOT NULL,
      container_id      INTEGER,
      inbound_order_id  INTEGER,
      outbound_order_id INTEGER,
      species           TEXT,
      grade             TEXT,
      thickness         REAL,
      width             REAL,
      length            REAL,
      pieces            INTEGER,
      cubic             REAL,
      status            TEXT    NOT NULL DEFAULT 'in_stock',
      created_at        TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
      shipped_at        TEXT,
      barcode           TEXT,
      shipment_id       INTEGER,
      box_no            TEXT,
      scope_key         TEXT
    );
  `)

  const insert = db.prepare(
    `INSERT INTO bales_new
       (id, bale_no, container_id, inbound_order_id, outbound_order_id, species, grade,
        thickness, width, length, pieces, cubic, status, created_at, shipped_at,
        barcode, shipment_id, box_no, scope_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  // 同一个范围内重名的：保留 id 最大的（最新的），其余删掉并报出来
  const seen = new Map()
  const dropped = []
  const kept = [...rows].sort((a, b) => a.id - b.id)
  for (const row of kept) {
    const key = `${scopeOf(row)}|${row.bale_no}`
    if (seen.has(key)) {
      dropped.push(`${row.bale_no}(id=${row.id})`)
      continue
    }
    seen.set(key, row.id)
    insert.run(
      row.id, row.bale_no, row.container_id ?? null, row.inbound_order_id ?? null,
      row.outbound_order_id ?? null, row.species ?? null, row.grade ?? null,
      row.thickness ?? null, row.width ?? null, row.length ?? null, row.pieces ?? null,
      row.cubic ?? null, row.status, row.created_at, row.shipped_at ?? null,
      row.barcode ?? row.bale_no, row.shipment_id ?? null, row.box_no ?? null,
      scopeOf(row),
    )
  }

  db.exec(`DROP TABLE bales`)
  db.exec(`ALTER TABLE bales_new RENAME TO bales`)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_bales_container ON bales (container_id);
    CREATE INDEX IF NOT EXISTS idx_bales_status    ON bales (status, id);
    CREATE INDEX IF NOT EXISTS idx_bales_inbound   ON bales (inbound_order_id);
    CREATE INDEX IF NOT EXISTS idx_bales_outbound  ON bales (outbound_order_id);
    CREATE INDEX IF NOT EXISTS idx_bales_barcode   ON bales (barcode);
    CREATE INDEX IF NOT EXISTS idx_bales_shipment  ON bales (shipment_id);
  `)

  writeLog(
    `[db] 迁移：包号唯一范围改为「提单内 / 散货按入库单」，重建 bales 表（搬了 ${rows.length} 行）`,
  )
  // 顺手清掉孤儿规格行（包被删了但规格行还在，白占地方）
  const orphans = db
    .prepare(
      `DELETE FROM bale_items
        WHERE bale_id NOT IN (SELECT id FROM bales)`,
    )
    .run()
  if (orphans.changes > 0) {
    writeLog(`[db] 清理：删掉 ${orphans.changes} 行已经没有包的孤儿规格行`)
  }
  if (dropped.length > 0) {
    writeLog(`[db] 警告：同范围内包号重复，已保留最新一条、删除旧的：${dropped.join('、')}`)
  }
}

/**
 * 数据修复：入库单上填了提单号、但包还没挂到那张提单上的，
 * 按单号补挂一次，「采购入库明细」里才对得上。
 */
/**
 * 空提单清理：库里不该存在「一包货都没有」的提单。
 * 删单时已经会自动清，这里兜住历史遗留（每次启动扫一遍，有才动手并打印）。
 *
 * ⚠️ 「空」= **0 包 + 0 明细**，两个条件都要满足。
 * 只看"没有活包"会把跨提单改包后的源提单也删掉 ——
 * 那种提单是「有账（原 5）、没有包（现 0）」，界面上要显示「货在别人的包里」，
 * 删了用户就看不到自己的货去哪了。
 */
function cleanEmptyShipments() {
  const empties = db
    .prepare(
      `SELECT s.id, s.bl_no FROM shipments s
        WHERE s.deleted_at IS NULL
          AND NOT EXISTS (
                SELECT 1 FROM bales b
                 WHERE b.shipment_id = s.id AND b.deleted_at IS NULL
              )
          AND NOT EXISTS (
                SELECT 1 FROM order_items i
                  JOIN inbound_orders o ON o.id = i.order_id
                 WHERE i.order_type = 'in' AND i.deleted_at IS NULL AND o.deleted_at IS NULL
                   AND o.shipment_id = s.id
              )`,
    )
    .all()
  if (empties.length === 0) return

  const softDelete = db.prepare(
    `UPDATE shipments SET deleted_at = datetime('now', 'localtime')
      WHERE id = ? AND deleted_at IS NULL`,
  )
  for (const ship of empties) softDelete.run(ship.id)
  writeLog(
    `[db] 清理空提单 ${empties.length} 张（一包货都没有的）：` +
      empties.map((s) => `${s.bl_no}(id=${s.id})`).join('、'),
  )
}

function relinkBalesToShipment() {
  // 先补：入库单填了提单号、但系统里还没有这张提单的，按单上的信息建一张
  const created = db
    .prepare(
      `INSERT INTO shipments (bl_no, contract_no, supplier, arrival_date, remark)
       SELECT o.bl_no,
              (SELECT o2.contract_no FROM inbound_orders o2
                WHERE o2.bl_no = o.bl_no AND o2.deleted_at IS NULL
                ORDER BY o2.id DESC LIMIT 1),
              (SELECT o3.supplier FROM inbound_orders o3
                WHERE o3.bl_no = o.bl_no AND o3.deleted_at IS NULL
                ORDER BY o3.id DESC LIMIT 1),
              (SELECT o4.order_date FROM inbound_orders o4
                WHERE o4.bl_no = o.bl_no AND o4.deleted_at IS NULL
                ORDER BY o4.id DESC LIMIT 1),
              '按入库单上的提单号自动补建'
         FROM inbound_orders o
        WHERE o.deleted_at IS NULL
          AND o.bl_no IS NOT NULL AND TRIM(o.bl_no) <> ''
          AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.bl_no = o.bl_no)
        GROUP BY o.bl_no`,
    )
    .run()
  if (created.changes > 0) {
    writeLog(`[db] 修复：按入库单上的提单号补建了 ${created.changes} 张提单`)
  }

  const result = db
    .prepare(
      `UPDATE bales
          SET shipment_id = (
                SELECT s.id FROM shipments s
                  JOIN inbound_orders o ON o.bl_no = s.bl_no
                 WHERE o.id = bales.inbound_order_id AND s.deleted_at IS NULL
                 LIMIT 1
              )
        WHERE shipment_id IS NULL AND inbound_order_id IS NOT NULL`,
    )
    .run()
  if (result.changes > 0) {
    writeLog(`[db] 修复：把 ${result.changes} 个包按入库单上的提单号补挂到提单`)
  }
}

/**
 * 去掉「柜」这一层：码单（包）直接挂在提单下。
 *
 * 老数据里包是挂在柜上的，这里把柜上的提单号搬到包上；
 * 柜没挂提单的（当年用「单独加柜」建的），照柜上的提单号 / 柜号补一张提单出来。
 * containers 表保留不动，只是界面不再出现「柜」。
 */
function migrateDropContainerLayer() {
  addColumnIfMissing('bales', 'shipment_id', 'INTEGER')
  addColumnIfMissing('inbound_orders', 'shipment_id', 'INTEGER')

  // 没挂提单的柜：按柜上的提单号补一张提单（没有提单号就拿柜号当提单号）
  const orphans = db
    .prepare(
      `SELECT * FROM containers
        WHERE deleted_at IS NULL AND (shipment_id IS NULL OR shipment_id = 0)`,
    )
    .all()
  for (const box of orphans) {
    const blNo = String(box.bl_no ?? '').trim() || box.container_no
    const exists = db
      // 和入库 / 提单管理一个口径：大小写不敏感 + 两边去空格
      .prepare(
        `SELECT id FROM shipments
          WHERE lower(trim(bl_no)) = lower(trim(?)) AND deleted_at IS NULL`,
      )
      .get(blNo)
    let shipmentId = exists?.id
    if (!shipmentId) {
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO shipments (bl_no, contract_no, supplier, arrival_date, remark)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          String(blNo).trim(),
          box.contract_no ?? null,
          box.supplier ?? null,
          box.arrive_date ?? null,
          '由柜迁移生成',
        )
      shipmentId = Number(lastInsertRowid)
    }
    db.prepare(`UPDATE containers SET shipment_id = ? WHERE id = ?`).run(
      shipmentId,
      box.id,
    )
  }

  // 包挂到柜所属的提单上
  db.exec(`
    UPDATE bales
       SET shipment_id = (
             SELECT c.shipment_id FROM containers c WHERE c.id = bales.container_id
           )
     WHERE shipment_id IS NULL AND container_id IS NOT NULL
  `)

  // 入库单也挂到提单上
  db.exec(`
    UPDATE inbound_orders
       SET shipment_id = (
             SELECT c.shipment_id FROM containers c WHERE c.id = inbound_orders.container_id
           )
     WHERE shipment_id IS NULL AND container_id IS NOT NULL
  `)

  db.exec(`CREATE INDEX IF NOT EXISTS idx_bales_shipment ON bales (shipment_id)`)
  writeLog('[db] 迁移：码单与入库单增加 shipment_id，去掉「柜」这一层（提单直接挂包）')
}

// 首次初始化时建一个默认管理员（表非空则跳过）
function seedDefaultAdmin() {
  const total = db.prepare(`SELECT COUNT(*) AS total FROM users`).get().total
  if (total > 0) return

  db.prepare(
    `INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')`,
  ).run(DEFAULT_ADMIN.username, bcrypt.hashSync(DEFAULT_ADMIN.password, 10))
  writeLog(
    `[users] 已创建默认账号 ${DEFAULT_ADMIN.username} / ${DEFAULT_ADMIN.password}，请尽快修改`,
  )
}

// 常用项字典：库里一条都没有时塞几个常见的品名 / 等级，用户可自行增删改
const DEFAULT_DICT = {
  species: ['樟子松', '白松', '云杉', '落叶松'],
  grade: ['SLDK', 'SF', 'A', 'B'],
}

function seedDict() {
  const total = Number(
    db.prepare(`SELECT COUNT(*) AS total FROM dict_items`).get()?.total ?? 0,
  )
  if (total > 0) return

  const insert = db.prepare(
    `INSERT OR IGNORE INTO dict_items (kind, name, sort_order) VALUES (?, ?, ?)`,
  )
  let order = 0
  for (const [kind, names] of Object.entries(DEFAULT_DICT)) {
    for (const name of names) {
      insert.run(kind, name, order)
      order += 1
    }
  }
  writeLog(
    `[dict] 已写入默认常用项：品名 ${DEFAULT_DICT.species.length} 个、等级 ${DEFAULT_DICT.grade.length} 个`,
  )
}

/**
 * 空库 + 有备份 = 库多半是被覆盖掉了，必须喊出来，
 * 而不是安安静静地当成「一个全新的空系统」继续跑。
 */
/* ---------- 每日快照（保留最近 7 份） ---------- */

const snapshotDir = path.join(activeDir, 'snapshots')
const SNAPSHOT_KEEP = 7

/** 本地日期 YYYY-MM-DD */
function localDate(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 只留最近 N 份，其余删掉（按文件名倒序 = 按日期倒序） */
function pruneSnapshots() {
  const files = fs
    .readdirSync(snapshotDir)
    .filter((name) => /^data-\d{4}-\d{2}-\d{2}\.db$/.test(name))
    .sort()
    .reverse()

  for (const name of files.slice(SNAPSHOT_KEEP)) {
    try {
      fs.unlinkSync(path.join(snapshotDir, name))
      writeLog(`[db] 快照清理：删掉过期快照 ${name}`)
    } catch (err) {
      writeLog(`[警告] 删除旧快照 ${name} 失败：${err?.message ?? err}`)
    }
  }
}

/**
 * 打一份当天快照到 <数据目录>/snapshots/data-YYYY-MM-DD.db
 * 同一天只留一份；正在事务里时跳过（内存库此刻不是一致状态），下次再打。
 */
export function snapshotNow(reason = '定时') {
  if (inTransaction) {
    writeLog('[db] 快照跳过：当前正在事务中，等下次')
    return null
  }

  try {
    fs.mkdirSync(snapshotDir, { recursive: true })
    const target = path.join(snapshotDir, `data-${localDate()}.db`)

    if (fs.existsSync(target)) return target

    const tmp = `${target}.tmp-${process.pid}`
    fs.writeFileSync(tmp, Buffer.from(raw.export()))
    fs.renameSync(tmp, target)
    writeLog(`[db] 快照已保存（${reason}）：${target}`)
    pruneSnapshots()
    return target
  } catch (err) {
    writeLog(`[警告] 快照失败（${reason}）：${err?.code ?? ''} ${err?.message ?? err}`)
    return null
  }
}

/**
 * 启动时补一份今天的快照，之后每小时检查一次（跨天自动生成新的一份）。
 * setInterval 不阻止进程退出。
 */
export function startDailySnapshots() {
  snapshotNow('启动')
  const timer = setInterval(() => snapshotNow('定时'), 60 * 60 * 1000)
  timer.unref?.()
  writeLog(`[db] 每日快照已开启：${snapshotDir}（保留最近 ${SNAPSHOT_KEEP} 份）`)
  return timer
}

function warnIfSuspiciouslyEmpty() {
  const backupPath = `${dbPath}.bak`

  try {
    const countOrders = () =>
      Number(db.prepare('SELECT COUNT(*) AS n FROM inbound_orders').get()?.n ?? 0) +
      Number(db.prepare('SELECT COUNT(*) AS n FROM outbound_orders').get()?.n ?? 0)

    if (countOrders() > 0 || !fs.existsSync(backupPath)) return

    const backup = new SQL.Database(fs.readFileSync(backupPath))
    let backupOrders = 0
    try {
      const readCount = (table) => {
        try {
          return Number(backup.exec(`SELECT COUNT(*) FROM ${table}`)[0]?.values?.[0]?.[0] ?? 0)
        } catch {
          return 0
        }
      }
      backupOrders = readCount('inbound_orders') + readCount('outbound_orders')
    } finally {
      backup.close()
    }

    if (backupOrders > 0) {
      writeLog(
        `[警告] 当前数据库一张单据都没有，但备份里还有 ${backupOrders} 张：${backupPath}\n` +
          '        如果不是你自己清空的，说明数据文件被覆盖过。恢复办法：\n' +
          `        先停掉后端，把 ${backupPath} 复制成 ${dbPath}，再启动即可。`,
      )
    }
  } catch (err) {
    writeLog(`[警告] 空库检查失败：${err?.message ?? err}`)
  }
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
  migrateMoneyToCents()
  migrateSoftDelete()
  migrateOrderFields()
  migrateBaleBarcode()
  migrateVehicleNo()
  migrateDropContainerLayer()
  migrateShipmentDropInlineUnique()
  migrateShipmentBlNoUnique()
  migrateContractDropInlineUnique()
  migrateContractNoUnique()
  migrateBoxNo()
  migrateBrand()
  migrateBaleItemPrice()
  migrateBaleItemSourceOrder()
  migrateBaleSoftDelete()
  migrateOrderItemBaleNo()
  migrateRepackCreator()
  migrateUserRoles()
  migrateRepackSplit()
  migrateBaleNoGlobalUnique()
  relinkBalesToShipment()
  // 补挂之后再看一遍：如果某张提单还是没货，就清掉
  cleanEmptyShipments()
  // 注意顺序：补挂提单会改 shipment_id，范围键必须在它之后再算
  migrateBaleScope()
  seedDefaultAdmin()
  seedDict()
  warnIfSuspiciouslyEmpty()
  writeLog('[db] ✓ initDB 完成')
  return db
}

writeLog('[db] … 模块加载时执行 initDB')
initDB()
