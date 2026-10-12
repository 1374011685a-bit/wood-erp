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

// 首页汇总
router.get('/summary', (_req, res) => {
  const today = todayLocal()
  const stock = totalStockStmt.get()
  const todayIn = dailyStmt.in.get(today)
  const todayOut = dailyStmt.out.get(today)
  const stockAmount = stockAmountStmt.get()

  res.json({
    total_stock_cubic: roundTo(stock.cubic ?? 0, 4),
    total_stock_bundles: stock.bundles ?? 0,
    total_stock_amount: roundTo(stockAmount?.amount ?? 0, 2),
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
