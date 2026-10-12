import express from 'express'
import { db } from '../db.js'

const router = express.Router()

const roundTo = (value, digits) => Number(value.toFixed(digits))

/** 本地日期 YYYY-MM-DD */
function todayLocal() {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

// 全库当前库存：入库合计 - 出库合计（所有规格）
const totalStockStmt = db.prepare(
  `SELECT COALESCE(SUM(CASE WHEN order_type = 'in' THEN cubic   ELSE -cubic   END), 0) AS cubic,
          COALESCE(SUM(CASE WHEN order_type = 'in' THEN bundles ELSE -bundles END), 0) AS bundles
     FROM order_items
    WHERE deleted_at IS NULL`,
)

// 指定日期、指定方向的立方与金额合计
const dailyStmt = {
  in: db.prepare(
    `SELECT COALESCE(SUM(i.cubic), 0)  AS cubic,
            COALESCE(SUM(COALESCE(i.amount_cents, ROUND(i.amount * 100))), 0) / 100.0 AS amount
       FROM order_items i
       JOIN inbound_orders o ON o.id = i.order_id
      WHERE i.order_type = 'in' AND i.deleted_at IS NULL
        AND o.deleted_at IS NULL AND o.order_date = ?`,
  ),
  out: db.prepare(
    `SELECT COALESCE(SUM(i.cubic), 0)  AS cubic,
            COALESCE(SUM(COALESCE(i.amount_cents, ROUND(i.amount * 100))), 0) / 100.0 AS amount
       FROM order_items i
       JOIN outbound_orders o ON o.id = i.order_id
      WHERE i.order_type = 'out' AND i.deleted_at IS NULL
        AND o.deleted_at IS NULL AND o.order_date = ?`,
  ),
}

/**
 * 库存总金额（只看个大概盘子，不做加权平均）：
 * 每个有库存的规格取「当前立方 × 该规格最近一次入库单价」，再全部相加
 */
const stockAmountStmt = db.prepare(
  `SELECT COALESCE(SUM(ROUND(t.cubic * COALESCE(t.last_unit_price_cents, 0))), 0) / 100.0 AS amount
     FROM (
       SELECT SUM(CASE WHEN i.order_type = 'in' THEN i.cubic ELSE -i.cubic END) AS cubic,
              (SELECT COALESCE(s.unit_price_cents, ROUND(s.unit_price * 100))
                 FROM order_items s
                WHERE s.order_type = 'in'
                  AND s.deleted_at IS NULL
                  AND COALESCE(s.species, '') = COALESCE(i.species, '')
                  AND COALESCE(s.grade, '')   = COALESCE(i.grade, '')
                  AND s.thickness = i.thickness
                  AND s.width     = i.width
                  AND s.length    = i.length
                ORDER BY s.id DESC
                LIMIT 1) AS last_unit_price_cents
         FROM order_items i
        WHERE i.deleted_at IS NULL
        GROUP BY i.species, i.grade, i.thickness, i.width, i.length
       HAVING SUM(CASE WHEN i.order_type = 'in' THEN i.cubic ELSE -i.cubic END) > 0
     ) t`,
)

// 最近 10 条出入库记录（合并后按创建时间倒序）
// 注意：UNION ALL 外面要再包一层，否则 SQLite 不认直接写成列名的 ORDER BY
const recentStmt = db.prepare(
  `SELECT *
     FROM (
       SELECT 'in' AS type,
              o.order_no,
              o.supplier AS partner,
              o.order_date,
              o.created_at,
              ROUND(COALESCE(SUM(i.cubic), 0), 4)  AS total_cubic,
              ROUND(COALESCE(SUM(COALESCE(i.amount_cents, ROUND(i.amount * 100))), 0) / 100.0, 2)
                                                   AS total_amount,
              COUNT(i.id)                          AS item_count
         FROM inbound_orders o
         LEFT JOIN order_items i
                ON i.order_id = o.id AND i.order_type = 'in' AND i.deleted_at IS NULL
        WHERE o.deleted_at IS NULL
        GROUP BY o.id

       UNION ALL

       SELECT 'out' AS type,
              o.order_no,
              o.customer AS partner,
              o.order_date,
              o.created_at,
              ROUND(COALESCE(SUM(i.cubic), 0), 4)  AS total_cubic,
              ROUND(COALESCE(SUM(COALESCE(i.amount_cents, ROUND(i.amount * 100))), 0) / 100.0, 2)
                                                   AS total_amount,
              COUNT(i.id)                          AS item_count
         FROM outbound_orders o
         LEFT JOIN order_items i
                ON i.order_id = o.id AND i.order_type = 'out' AND i.deleted_at IS NULL
        WHERE o.deleted_at IS NULL
        GROUP BY o.id
     )
    ORDER BY created_at DESC, order_no DESC
    LIMIT 10`,
)

/* ---------- 看板数据 ---------- */

/** 本地日期 YYYY-MM-DD（可偏移天数） */
function localDate(offsetDays = 0) {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

const TREND_DAYS = 14
const TREND_OPTIONS = [7, 14, 30]
const DIMENSIONS = ['spec', 'species', 'grade']

// 逐日进出立方（只取有单据的日期，其余在 JS 里补 0）
const trendStmt = (table, type) =>
  db.prepare(
    `SELECT o.order_date AS date,
            COALESCE(SUM(i.cubic), 0) AS cubic
       FROM ${table} o
       LEFT JOIN order_items i
              ON i.order_id = o.id AND i.order_type = '${type}' AND i.deleted_at IS NULL
      WHERE o.deleted_at IS NULL AND o.order_date >= ?
      GROUP BY o.order_date`,
  )

const trendInStmt = trendStmt('inbound_orders', 'in')
const trendOutStmt = trendStmt('outbound_orders', 'out')

// 库存构成：按规格 / 品名 / 等级归组，取前几名 + 其他
const compositionStmt = {
  spec: db.prepare(
    `SELECT i.species, i.grade, i.thickness, i.width, i.length,
            SUM(CASE WHEN i.order_type = 'in' THEN i.cubic ELSE -i.cubic END) AS cubic
       FROM order_items i
      WHERE i.deleted_at IS NULL
      GROUP BY i.species, i.grade, i.thickness, i.width, i.length
     HAVING SUM(CASE WHEN i.order_type = 'in' THEN i.cubic ELSE -i.cubic END) > 0
      ORDER BY cubic DESC`,
  ),
  species: db.prepare(
    `SELECT i.species,
            SUM(CASE WHEN i.order_type = 'in' THEN i.cubic ELSE -i.cubic END) AS cubic
       FROM order_items i
      WHERE i.deleted_at IS NULL
      GROUP BY i.species
     HAVING SUM(CASE WHEN i.order_type = 'in' THEN i.cubic ELSE -i.cubic END) > 0
      ORDER BY cubic DESC`,
  ),
  grade: db.prepare(
    `SELECT i.grade,
            SUM(CASE WHEN i.order_type = 'in' THEN i.cubic ELSE -i.cubic END) AS cubic
       FROM order_items i
      WHERE i.deleted_at IS NULL
      GROUP BY i.grade
     HAVING SUM(CASE WHEN i.order_type = 'in' THEN i.cubic ELSE -i.cubic END) > 0
      ORDER BY cubic DESC`,
  ),
}

/** 把归组结果拼成一行文字标签 */
function compositionLabel(row, dimension) {
  if (dimension === 'species') return row.species || '（未填品名）'
  if (dimension === 'grade') return row.grade || '（未填等级）'
  return `${row.species ?? ''} ${row.grade ?? ''} ${row.thickness}×${row.width}×${row.length}`
    .replace(/\s+/g, ' ')
    .trim()
}

/** 某个日期区间内的出入库合计（立方 + 元），用于环比 / 同比 */
function sumRange(table, type, from, to) {
  return db
    .prepare(
      `SELECT COALESCE(SUM(i.cubic), 0) AS cubic,
              COALESCE(SUM(COALESCE(i.amount_cents, ROUND(i.amount * 100))), 0) / 100.0 AS amount
         FROM ${table} o
         LEFT JOIN order_items i
                ON i.order_id = o.id AND i.order_type = '${type}' AND i.deleted_at IS NULL
        WHERE o.deleted_at IS NULL AND o.order_date >= ? AND o.order_date <= ?`,
    )
    .get(from, to)
}

/** 同比用：把日期整体挪一年（2/29 之类由 Date 自己兜底） */
function shiftYear(date, delta) {
  const [y, m, d] = date.split('-').map(Number)
  const shifted = new Date(y + delta, m - 1, d)
  const month = String(shifted.getMonth() + 1).padStart(2, '0')
  const day = String(shifted.getDate()).padStart(2, '0')
  return `${shifted.getFullYear()}-${month}-${day}`
}

const percentChange = (current, base) =>
  base === 0 ? null : roundTo(((current - base) / base) * 100, 2)

/* ---------- 进货视角（源头进口：一次一大批，看批次不看期间） ---------- */

// 最近一批到货
const recentArrivalStmt = db.prepare(
  `SELECT o.order_no,
          o.order_date,
          o.supplier,
          ROUND(COALESCE(SUM(i.cubic), 0), 4) AS cubic,
          ROUND(COALESCE(SUM(COALESCE(i.amount_cents, ROUND(i.amount * 100))), 0) / 100.0, 2)
                                              AS amount
     FROM inbound_orders o
     LEFT JOIN order_items i
            ON i.order_id = o.id AND i.order_type = 'in' AND i.deleted_at IS NULL
    WHERE o.deleted_at IS NULL
    GROUP BY o.id
    ORDER BY o.order_date DESC, o.id DESC
    LIMIT 1`,
)

// 近一年的到货批次（批数用单据数，不按期间平均）
const arrivalCountStmt = db.prepare(
  `SELECT COUNT(*) AS batches
     FROM inbound_orders
    WHERE deleted_at IS NULL AND order_date >= ?`,
)

// 第一张出库单的日期：用来算「实际卖了几天」，数据不满 30 天时不能按 30 天平均
const firstOutboundStmt = db.prepare(
  `SELECT MIN(order_date) AS first_date FROM outbound_orders WHERE deleted_at IS NULL`,
)

function daysBetween(fromDate, toDate) {
  const a = new Date(`${fromDate}T00:00:00`)
  const b = new Date(`${toDate}T00:00:00`)
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 1
  return Math.max(1, Math.round((b - a) / 86400000) + 1)
}

// 应收 = 出库金额 - 已收款；应付 = 入库金额 - 已付款
const orderAmountStmt = (table, type) =>
  db.prepare(
    `SELECT COALESCE(SUM(COALESCE(i.amount_cents, ROUND(i.amount * 100))), 0) AS cents
       FROM ${table} o
       LEFT JOIN order_items i
              ON i.order_id = o.id AND i.order_type = '${type}' AND i.deleted_at IS NULL
      WHERE o.deleted_at IS NULL`,
  )

const outboundAmountStmt = orderAmountStmt('outbound_orders', 'out')
const inboundAmountStmt = orderAmountStmt('inbound_orders', 'in')
const paidStmt = db.prepare(
  `SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM payments WHERE side = ?`,
)

// 首页汇总
router.get('/summary', (req, res) => {
  const today = todayLocal()

  // 走势周期：7 / 14 / 30 天，默认 14
  const rawDays = Number(req.query.days)
  const days = TREND_OPTIONS.includes(rawDays) ? rawDays : TREND_DAYS

  // 构成维度：规格 / 品名 / 等级，默认规格
  const rawDimension = String(req.query.dimension ?? '')
  const dimension = DIMENSIONS.includes(rawDimension) ? rawDimension : 'spec'

  const stock = totalStockStmt.get()
  const todayIn = dailyStmt.in.get(today)
  const todayOut = dailyStmt.out.get(today)
  const stockAmount = stockAmountStmt.get()

  // 最近 N 天进出走势（没有单据的日期补 0，前端直接画图）
  const from = localDate(-(days - 1))
  const byDate = new Map()
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = localDate(-i)
    byDate.set(date, { date, in_cubic: 0, out_cubic: 0 })
  }
  for (const row of trendInStmt.all(from)) {
    const hit = byDate.get(row.date)
    if (hit) hit.in_cubic = roundTo(row.cubic ?? 0, 4)
  }
  for (const row of trendOutStmt.all(from)) {
    const hit = byDate.get(row.date)
    if (hit) hit.out_cubic = roundTo(row.cubic ?? 0, 4)
  }

  // 库存构成：前 6 项 + 其他，按立方算占比
  const compositionRows = compositionStmt[dimension].all().map((row) => ({
    label: compositionLabel(row, dimension),
    cubic: roundTo(row.cubic ?? 0, 4),
  }))
  const compositionTotal = compositionRows.reduce((sum, row) => sum + row.cubic, 0)
  const top = compositionRows.slice(0, 6)
  const rest = compositionRows.slice(6)
  if (rest.length > 0) {
    top.push({
      label: `其他 ${rest.length} 项`,
      cubic: roundTo(
        rest.reduce((sum, row) => sum + row.cubic, 0),
        4,
      ),
    })
  }
  const composition = top.map((row) => ({
    label: row.label,
    cubic: row.cubic,
    share: compositionTotal > 0 ? roundTo((row.cubic / compositionTotal) * 100, 1) : 0,
  }))

  /**
   * 环比 / 同比：
   * - 环比 = 本周期 vs 紧挨着的前一个同长度周期
   * - 同比 = 本周期 vs 去年同一段日期
   * 基数为 0 时百分比给 null，前端显示「—」，不硬凑数字
   */
  const prevFrom = localDate(-(days * 2 - 1))
  const prevTo = localDate(-days)
  const yoyFrom = shiftYear(from, -1)
  const yoyTo = shiftYear(today, -1)

  const buildCompare = (table, type) => {
    const current = sumRange(table, type, from, today)
    const prev = sumRange(table, type, prevFrom, prevTo)
    const yoy = sumRange(table, type, yoyFrom, yoyTo)
    const currentCubic = roundTo(current.cubic ?? 0, 4)
    const prevCubic = roundTo(prev.cubic ?? 0, 4)
    const yoyCubic = roundTo(yoy.cubic ?? 0, 4)
    const currentAmount = roundTo(current.amount ?? 0, 2)
    const prevAmount = roundTo(prev.amount ?? 0, 2)
    const yoyAmount = roundTo(yoy.amount ?? 0, 2)

    return {
      cubic: currentCubic,
      amount: currentAmount,
      prev_cubic: prevCubic,
      prev_amount: prevAmount,
      yoy_cubic: yoyCubic,
      yoy_amount: yoyAmount,
      mom_percent: percentChange(currentCubic, prevCubic),
      yoy_percent: percentChange(currentCubic, yoyCubic),
      mom_amount_percent: percentChange(currentAmount, prevAmount),
      yoy_amount_percent: percentChange(currentAmount, yoyAmount),
    }
  }

  const compare = {
    days,
    dimension,
    period: { from, to: today },
    prev: { from: prevFrom, to: prevTo },
    yoy: { from: yoyFrom, to: yoyTo },
    in: buildCompare('inbound_orders', 'in'),
    out: buildCompare('outbound_orders', 'out'),
  }

  /**
   * 「还能卖多久」：源头进口商最关心的一个数——按近期出货速度，手里的货还能撑几天，
   * 什么时候该订下一柜。日均按实际卖了几天算（数据不满 30 天时不硬按 30 天摊）。
   */
  const outbound30 = sumRange('outbound_orders', 'out', localDate(-29), today)
  const outbound30Cubic = roundTo(outbound30.cubic ?? 0, 4)
  const firstOutbound = firstOutboundStmt.get()?.first_date
  const soldDays = firstOutbound ? Math.min(30, daysBetween(firstOutbound, today)) : 30
  const dailyOutCubic = roundTo(outbound30Cubic / soldDays, 4)
  const daysOfSupply =
    dailyOutCubic > 0
      ? Math.round(roundTo(stock.cubic ?? 0, 4) / dailyOutCubic)
      : null

  // 最近一批到货 + 近一年到货批次（进货看批次，不看期间平均）
  const arrival = recentArrivalStmt.get()
  const arrivalBatches = Number(arrivalCountStmt.get(localDate(-364))?.batches ?? 0)

  // 应收 / 应付（元）
  const receivableCents =
    Number(outboundAmountStmt.get()?.cents ?? 0) - Number(paidStmt.get('customer')?.cents ?? 0)
  const payableCents =
    Number(inboundAmountStmt.get()?.cents ?? 0) - Number(paidStmt.get('supplier')?.cents ?? 0)

  // 较昨日：昨日库存 = 当前 - 今日进 + 今日出
  const currentCubic = roundTo(stock.cubic ?? 0, 4)
  const deltaCubic = roundTo((todayIn.cubic ?? 0) - (todayOut.cubic ?? 0), 4)
  const yesterdayCubic = roundTo(currentCubic - deltaCubic, 4)

  res.json({
    total_stock_cubic: currentCubic,
    total_stock_bundles: stock.bundles ?? 0,
    total_stock_amount: roundTo(stockAmount?.amount ?? 0, 2),
    stock_delta_cubic: deltaCubic,
    stock_delta_percent:
      yesterdayCubic !== 0 ? roundTo((deltaCubic / yesterdayCubic) * 100, 2) : 0,
    receivable_total: roundTo(receivableCents / 100, 2),
    payable_total: roundTo(payableCents / 100, 2),
    trend: [...byDate.values()],
    composition,
    composition_dimension: dimension,
    compare,
    daily_out_cubic: dailyOutCubic,
    outbound_30d_cubic: outbound30Cubic,
    sold_days: soldDays,
    days_of_supply: daysOfSupply,
    recent_arrival: arrival
      ? {
          order_no: arrival.order_no,
          order_date: arrival.order_date,
          supplier: arrival.supplier,
          cubic: roundTo(arrival.cubic ?? 0, 4),
          amount: roundTo(arrival.amount ?? 0, 2),
          days_ago: arrival.order_date
            ? daysBetween(arrival.order_date, today) - 1
            : null,
        }
      : null,
    arrival_batches_365: arrivalBatches,
    today_in_cubic: roundTo(todayIn.cubic ?? 0, 4),
    today_in_amount: roundTo(todayIn.amount ?? 0, 2),
    today_out_cubic: roundTo(todayOut.cubic ?? 0, 4),
    today_out_amount: roundTo(todayOut.amount ?? 0, 2),
    recent_records: recentStmt.all().map((row) => ({
      type: row.type,
      order_no: row.order_no,
      partner: row.partner,
      order_date: row.order_date,
      total_cubic: row.total_cubic ?? 0,
      total_amount: row.total_amount ?? 0,
      item_count: row.item_count ?? 0,
      created_at: row.created_at,
    })),
  })
})

export default router
