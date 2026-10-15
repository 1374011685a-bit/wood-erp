import { db } from './db.js'
import { BALE_TEXT_COLS, baleTextFields } from './routes/bales.js'
import { stockSql } from './routes/stock.js'

/**
 * AI 助手的**只读**查询工具。
 *
 * 三条硬规矩：
 *   1) 只读 —— 这里只有 SELECT，一个写操作都没有。
 *   2) 口径复用现有页面 —— 库存走 `routes/stock.js` 的 `stockSql`，
 *      混装包的斜杠串走 `routes/bales.js` 的 `BALE_TEXT_COLS`。
 *      AI 报出来的数字必须和界面上看到的一模一样，否则用户第一次对不上就不信了。
 *   3) 金额按角色裁 —— 看不到金额的角色（业务员 / 仓管 / 只读），
 *      这些字段**在送给模型的 JSON 里就不存在**，不是让模型别说。见 `stripMoney`。
 */

const roundTo = (value, digits) => Number(Number(value ?? 0).toFixed(digits))

/** 一次最多回多少行给模型（太多会把上下文撑爆，也太慢） */
const MAX_ROWS = 50
const clampLimit = (value, fallback = 20) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), MAX_ROWS)
}
const like = (value) => {
  const text = String(value ?? '').trim()
  return text ? `%${text}%` : ''
}

/** 给模型看的工具说明书（DeepSeek / OpenAI 兼容的 function 定义） */
export const TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'query_stock',
      description:
        '查当前库存（按品名+等级+厚+宽+长归组）。问「还有多少方 / 什么规格剩多少 / 库存里有没有 X」用这个。',
      parameters: {
        type: 'object',
        properties: {
          species: { type: 'string', description: '品名关键字，比如「樟子松」。不填就是全部' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_bales',
      description:
        '查码单（一包一行）：包号、条码号、柜号、规格、片数、立方、在库还是已出、挂在哪张入库单下。问「XX 这包几方 / 某个条码是哪包 / 哪些包还没出」用这个。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '包号 / 条码号 / 柜号 / 品名 / 提单号的关键字' },
          status: {
            type: 'string',
            enum: ['in_stock', 'shipped', 'all'],
            description: '在库 / 已出库 / 全部，默认全部',
          },
          limit: { type: 'integer', description: '最多返回几条，默认 20，最多 50' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_orders',
      description:
        '查入库单 / 出库单列表（单号、日期、往来单位、总立方、包数/明细数）。问「最近入了什么货 / 某天出了多少 / 有没有这张单」用这个。',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['in', 'out'], description: 'in = 入库，out = 出库' },
          keyword: { type: 'string', description: '单号 / 供应商 / 客户 / 提单号 的关键字' },
          date_from: { type: 'string', description: '起始日期 YYYY-MM-DD' },
          date_to: { type: 'string', description: '截止日期 YYYY-MM-DD' },
          limit: { type: 'integer', description: '最多返回几条，默认 10，最多 50' },
        },
        required: ['type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_overview',
      description:
        '一张「经营快照」：库存按品名汇总、在库/已出库包数、最近 30 天入库和出库方数、还没到齐的合同。' +
        '用户问「现在什么情况 / 该注意什么 / 给我点建议 / 最近怎么样」这类问题时，**先调这个**再回答。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_contracts',
      description:
        '查采购合同：合同号、名称、往来单位、合同立方、已入库立方、还差多少方。问「合同进度 / 某个合同到了多少货」用这个。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '合同号 / 名称 / 往来单位 的关键字' },
          limit: { type: 'integer', description: '最多返回几条，默认 10，最多 50' },
        },
      },
    },
  },
]

/* ---------- 各个工具的实现 ---------- */

const toolStock = (args, { seesMoney }) => {
  const species = String(args?.species ?? '').trim()
  const rows = db.prepare(stockSql(Boolean(species))).all(...(species ? [`%${species}%`] : []))
  const items = rows.map((row) => {
    const out = {
      品名: row.species,
      等级: row.grade ?? '',
      规格: `${row.thickness}×${row.width}×${row.length}`,
      件数: row.total_bundles ?? 0,
      总片数: row.total_pieces ?? 0,
      立方: roundTo(row.total_cubic, 4),
    }
    if (seesMoney) {
      const price = row.avg_unit_price === null ? null : roundTo(row.avg_unit_price, 2)
      out.均价 = price
      out.金额 = price === null ? null : roundTo((row.total_cubic ?? 0) * price, 2)
    }
    return out
  })
  return {
    条数: items.length,
    合计立方: roundTo(
      items.reduce((sum, one) => sum + one.立方, 0),
      4,
    ),
    库存: items,
  }
}

const toolBales = (args) => {
  const conditions = []
  const params = []
  const key = like(args?.keyword)
  if (key) {
    conditions.push(
      `(b.bale_no LIKE ? OR b.barcode LIKE ? OR b.box_no LIKE ?
         OR b.species LIKE ? OR b.grade LIKE ? OR s.bl_no LIKE ?)`,
    )
    params.push(key, key, key, key, key, key)
  }
  const status = String(args?.status ?? 'all')
  if (status === 'in_stock' || status === 'shipped') {
    conditions.push(`b.status = ?`)
    params.push(status)
  }
  const where = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : ''
  const limit = clampLimit(args?.limit)

  const rows = db
    .prepare(
      `SELECT b.bale_no, b.barcode, b.box_no, b.species, b.grade,
              b.thickness, b.width, b.length, b.pieces, b.cubic, b.status,
              s.bl_no, io.order_no AS inbound_order_no, oo.order_no AS outbound_order_no,
              ${BALE_TEXT_COLS}
         FROM bales b
         LEFT JOIN shipments s        ON s.id = b.shipment_id
         LEFT JOIN inbound_orders io  ON io.id = b.inbound_order_id
         -- 只有已出库的行才有出库单号（撤销出库后指针还在，状态才是口径）
         LEFT JOIN outbound_orders oo ON oo.id = b.outbound_order_id AND b.status = 'shipped'
        WHERE b.deleted_at IS NULL ${where}
        ORDER BY b.status = 'in_stock' DESC, b.id DESC
        LIMIT ?`,
    )
    .all(...params, limit)

  return {
    条数: rows.length,
    说明: `最多返回 ${limit} 条（按在库优先排序）`,
    码单: rows.map((row) => {
      const text = baleTextFields(row)
      return {
        包号: row.bale_no || '（空）',
        条码号: row.barcode ?? '',
        规格: text.spec_text,
        片数: text.pieces_text,
        立方: roundTo(row.cubic, 4),
        状态: row.status === 'in_stock' ? '在库' : '已出库',
        柜号: row.box_no ?? '',
        提单号: row.bl_no ?? '',
        入库单: row.inbound_order_no ?? '',
        出库单: row.outbound_order_no ?? '',
      }
    }),
  }
}

const toolOrders = (args, { seesMoney }) => {
  const type = String(args?.type ?? 'in') === 'out' ? 'out' : 'in'
  const table = type === 'in' ? 'inbound_orders' : 'outbound_orders'
  const partnerCol = type === 'in' ? 'supplier' : 'customer'
  const conditions = [`o.deleted_at IS NULL`]
  const params = []
  const key = like(args?.keyword)
  if (key) {
    conditions.push(type === 'in' ? `(o.order_no LIKE ? OR o.supplier LIKE ? OR o.bl_no LIKE ?)` : `(o.order_no LIKE ? OR o.customer LIKE ?)`)
    params.push(...(type === 'in' ? [key, key, key] : [key, key]))
  }
  if (args?.date_from) {
    conditions.push(`o.order_date >= ?`)
    params.push(String(args.date_from))
  }
  if (args?.date_to) {
    conditions.push(`o.order_date <= ?`)
    params.push(String(args.date_to))
  }
  const limit = clampLimit(args?.limit, 10)

  const rows = db
    .prepare(
      `SELECT o.order_no, o.order_date, o.${partnerCol} AS partner, o.bl_no, o.contract_no,
              COUNT(i.id)                     AS item_count,
              COALESCE(SUM(i.cubic), 0)       AS total_cubic,
              COALESCE(SUM(i.bundles), 0)     AS total_bundles
                ${seesMoney ? `,
              COALESCE(SUM(COALESCE(i.amount_cents, ROUND(i.amount * 100))), 0) / 100.0 AS total_amount` : ''}
         FROM ${table} o
         LEFT JOIN order_items i
                ON i.order_id = o.id AND i.order_type = ? AND i.deleted_at IS NULL
        WHERE ${conditions.join(' AND ')}
        GROUP BY o.id
        ORDER BY o.order_date DESC, o.id DESC
        LIMIT ?`,
    )
    .all(type, ...params, limit)

  return {
    类型: type === 'in' ? '入库单' : '出库单',
    条数: rows.length,
    说明: `最多返回 ${limit} 条（按日期倒序）`,
    单据: rows.map((row) => {
      const out = {
        单号: row.order_no,
        日期: row.order_date,
        往来单位: row.partner ?? '',
        明细数: row.item_count ?? 0,
        立方: roundTo(row.total_cubic, 4),
      }
      if (type === 'in') {
        out.包数 = row.total_bundles ?? 0
        out.提单号 = row.bl_no ?? ''
        out.合同号 = row.contract_no ?? ''
      }
      if (seesMoney) out.金额 = roundTo(row.total_amount, 2)
      return out
    }),
  }
}

const toolContracts = (args, { seesMoney }) => {
  const conditions = [`ct.deleted_at IS NULL`]
  const params = []
  const key = like(args?.keyword)
  if (key) {
    conditions.push(`(ct.contract_no LIKE ? OR ct.title LIKE ? OR ct.partner LIKE ?)`)
    params.push(key, key, key)
  }
  const limit = clampLimit(args?.limit, 10)

  const rows = db
    .prepare(
      `SELECT ct.contract_no, ct.title, ct.partner, ct.sign_date,
              COALESCE((SELECT SUM(ci.quantity) FROM contract_items ci
                         WHERE ci.contract_id = ct.id), 0) AS contract_cubic,
              COALESCE((SELECT SUM(i.cubic) FROM order_items i
                          JOIN inbound_orders o ON o.id = i.order_id
                         WHERE o.contract_no = ct.contract_no
                           AND o.deleted_at IS NULL
                           AND i.deleted_at IS NULL AND i.order_type = 'in'), 0) AS in_cubic
                ${seesMoney ? `,
              COALESCE(ct.amount_cents, 0) / 100.0 AS amount` : ''}
         FROM contracts ct
        WHERE ${conditions.join(' AND ')}
        ORDER BY ct.id DESC
        LIMIT ?`,
    )
    .all(...params, limit)

  return {
    条数: rows.length,
    合同: rows.map((row) => {
      const contract = roundTo(row.contract_cubic, 4)
      const arrived = roundTo(row.in_cubic, 4)
      const out = {
        合同号: row.contract_no,
        名称: row.title ?? '',
        往来单位: row.partner ?? '',
        签订日期: row.sign_date,
        合同立方: contract,
        已入库立方: arrived,
        还差立方: roundTo(contract - arrived, 4),
      }
      if (seesMoney) out.金额 = roundTo(row.amount, 2)
      return out
    }),
  }
}

/**
 * 经营快照：一屏把「现在什么情况」能用的数据都取出来。
 *
 * 为什么要这个：光有按需查询，用户问「库存合不合理 / 该注意什么」时模型不知道该查啥，
 * 很容易给一堆放之四海皆准的空话。有了这张快照，建议才有本系统的数字垫底。
 */
const toolOverview = (_args, { seesMoney }) => {
  /* 库存按品名汇总（口径同 /api/stock） */
  const stockRows = db.prepare(stockSql(false)).all()
  const bySpecies = new Map()
  for (const row of stockRows) {
    const key = row.species ?? '（未填品名）'
    const one = bySpecies.get(key) ?? { 品名: key, 立方: 0, 件数: 0, 规格数: 0 }
    one.立方 += row.total_cubic ?? 0
    one.件数 += row.total_bundles ?? 0
    one.规格数 += 1
    bySpecies.set(key, one)
  }
  const 库存按品名 = [...bySpecies.values()]
    .map((one) => ({ ...one, 立方: roundTo(one.立方, 4) }))
    .sort((a, b) => b.立方 - a.立方)
  const 库存合计立方 = roundTo(
    库存按品名.reduce((sum, one) => sum + one.立方, 0),
    4,
  )

  /* 在库 / 已出库 包数 */
  const baleRows = db
    .prepare(
      `SELECT status, COUNT(*) AS n
         FROM bales
        WHERE deleted_at IS NULL
        GROUP BY status`,
    )
    .all()
  const 包数 = { 在库: 0, 已出库: 0 }
  for (const row of baleRows) {
    if (row.status === 'in_stock') 包数.在库 = row.n
    else 包数.已出库 = (包数.已出库 ?? 0) + row.n
  }

  /* 最近 30 天的进销（按单据日期，不是录单时间） */
  const since = db.prepare(`SELECT date('now', '-30 day') AS d`).get()?.d
  const flowOf = (type, table) =>
    roundTo(
      db
        .prepare(
          `SELECT COALESCE(SUM(i.cubic), 0) AS cubic
             FROM order_items i
             JOIN ${table} o ON o.id = i.order_id
            WHERE i.order_type = ? AND i.deleted_at IS NULL
              AND o.deleted_at IS NULL AND o.order_date >= ?`,
        )
        .get(type, since)?.cubic,
      4,
    )
  const 近30天 = {
    入库立方: flowOf('in', 'inbound_orders'),
    出库立方: flowOf('out', 'outbound_orders'),
    起算日: since,
  }

  /* 还没到齐的合同（只列前 5 个，别把上下文塞爆） */
  const contracts = toolContracts({ limit: 50 }, { seesMoney })
  const 未到齐 = (contracts.合同 ?? []).filter((one) => one.还差立方 > 0)
  const 合同情况 = {
    合同总数: contracts.条数,
    未到齐数量: 未到齐.length,
    ...(seesMoney
      ? {
          未到齐金额: roundTo(
            未到齐.reduce((sum, one) => sum + Number(one.金额 ?? 0), 0),
            2,
          ),
        }
      : {}),
    未到齐前5个: 未到齐.slice(0, 5).map((one) => ({
      合同号: one.合同号,
      合同立方: one.合同立方,
      已入库立方: one.已入库立方,
      还差立方: one.还差立方,
    })),
  }

  return {
    库存合计立方,
    库存按品名,
    包数,
    近30天,
    合同情况,
    说明: '库存口径和「库存」页一致；立方单位 m³，保留 4 位小数',
  }
}

const RUNNERS = {
  query_stock: toolStock,
  query_bales: toolBales,
  query_orders: toolOrders,
  query_overview: toolOverview,
  query_contracts: toolContracts,
}

/** 这个工具回给用户看的中文名（界面上显示「已查询：库存」） */
export const TOOL_LABELS = {
  query_stock: '库存',
  query_bales: '码单',
  query_orders: '单据',
  query_overview: '经营快照',
  query_contracts: '合同',
}

/** 执行一个工具。失败不抛给上层，回一条错误说明让模型自己跟用户解释 */
export function runTool(name, args, { seesMoney }) {
  const runner = RUNNERS[name]
  if (!runner) return { error: `没有这个查询工具：${name}` }
  try {
    return runner(args ?? {}, { seesMoney })
  } catch (err) {
    return { error: `查询出错：${err?.message ?? err}` }
  }
}
