import express from 'express'
import { db } from '../db.js'

const router = express.Router()

const roundTo = (value, digits) => Number((value ?? 0).toFixed(digits))

/**
 * 回收站：列出软删除的入库单 / 出库单。
 * 明细也一起打了删除标记，所以这些单据已经完全退出库存、流水和导出。
 */
const listSql = `
  SELECT 'in' AS type,
         o.id,
         o.order_no,
         o.supplier AS partner,
         o.order_date,
         o.deleted_at,
         ROUND(COALESCE(SUM(i.cubic), 0), 4)  AS total_cubic,
         ROUND(COALESCE(SUM(COALESCE(i.amount_cents, ROUND(i.amount * 100))), 0) / 100.0, 2)
                                              AS total_amount,
         COUNT(i.id)                          AS item_count
    FROM inbound_orders o
    LEFT JOIN order_items i ON i.order_id = o.id AND i.order_type = 'in'
   WHERE o.deleted_at IS NOT NULL
   GROUP BY o.id

   UNION ALL

  SELECT 'out' AS type,
         o.id,
         o.order_no,
         o.customer AS partner,
         o.order_date,
         o.deleted_at,
         ROUND(COALESCE(SUM(i.cubic), 0), 4)  AS total_cubic,
         ROUND(COALESCE(SUM(COALESCE(i.amount_cents, ROUND(i.amount * 100))), 0) / 100.0, 2)
                                              AS total_amount,
         COUNT(i.id)                          AS item_count
    FROM outbound_orders o
    LEFT JOIN order_items i ON i.order_id = o.id AND i.order_type = 'out'
   WHERE o.deleted_at IS NOT NULL
   GROUP BY o.id
`

router.get('/', (_req, res) => {
  const rows = db
    .prepare(`SELECT * FROM (${listSql}) ORDER BY deleted_at DESC, id DESC`)
    .all()

  res.json(
    rows.map((row) => ({
      type: row.type,
      id: row.id,
      order_no: row.order_no,
      partner: row.partner,
      order_date: row.order_date,
      deleted_at: row.deleted_at,
      total_cubic: roundTo(row.total_cubic ?? 0, 4),
      total_amount: roundTo(row.total_amount ?? 0, 2),
      item_count: row.item_count ?? 0,
    })),
  )
})

/* ---------- 恢复 ---------- */

const findDeletedStmt = {
  in: db.prepare(
    `SELECT id, order_no FROM inbound_orders WHERE id = ? AND deleted_at IS NOT NULL`,
  ),
  out: db.prepare(
    `SELECT id, order_no FROM outbound_orders WHERE id = ? AND deleted_at IS NOT NULL`,
  ),
}

const restoreOrderStmt = {
  in: db.prepare(`UPDATE inbound_orders SET deleted_at = NULL WHERE id = ?`),
  out: db.prepare(`UPDATE outbound_orders SET deleted_at = NULL WHERE id = ?`),
}

const restoreItemsStmt = {
  in: db.prepare(
    `UPDATE order_items SET deleted_at = NULL WHERE order_type = 'in' AND order_id = ?`,
  ),
  out: db.prepare(
    `UPDATE order_items SET deleted_at = NULL WHERE order_type = 'out' AND order_id = ?`,
  ),
}

/** 某规格当前库存（只看未删除的明细） */
const stockOfSpecStmt = db.prepare(
  `SELECT COALESCE(SUM(CASE WHEN order_type = 'in' THEN cubic   ELSE -cubic   END), 0) AS cubic,
          COALESCE(SUM(CASE WHEN order_type = 'in' THEN bundles ELSE -bundles END), 0) AS bundles
     FROM order_items
    WHERE deleted_at IS NULL
      AND species = ?
      AND COALESCE(grade, '') = ?
      AND thickness = ?
      AND width     = ?
      AND length    = ?`,
)

const orderItemsStmt = db.prepare(
  `SELECT species, grade, thickness, width, length, cubic, bundles
     FROM order_items
    WHERE order_type = ? AND order_id = ?`,
)

/**
 * 恢复单据。
 *
 * 恢复入库单只会把货加回来，永远安全；
 * 恢复出库单等于重新扣一次库存，所以要确认当前库存够扣（和出库保存同一套判断），
 * 不够就整体回滚并说清楚差在哪。
 */
const restoreOrder = db.transaction((type, id) => {
  const order = findDeletedStmt[type].get(id)
  if (!order) {
    const error = new Error('回收站里没有这张单据（可能已经恢复或彻底删除了）')
    error.status = 404
    throw error
  }

  if (type === 'out') {
    // 同规格的多行先合并
    const groups = new Map()
    for (const item of orderItemsStmt.all('out', id)) {
      const grade = item.grade ?? ''
      const key = [item.species, grade, item.thickness, item.width, item.length].join('|')
      const group = groups.get(key) ?? {
        species: item.species,
        grade,
        thickness: item.thickness,
        width: item.width,
        length: item.length,
        cubic: 0,
        bundles: 0,
      }
      group.cubic += item.cubic ?? 0
      group.bundles += item.bundles ?? 0
      groups.set(key, group)
    }

    const problems = []
    for (const group of groups.values()) {
      const stock = stockOfSpecStmt.get(
        group.species,
        group.grade,
        group.thickness,
        group.width,
        group.length,
      )
      const currentCubic = roundTo(stock?.cubic ?? 0, 4)
      const currentBundles = stock?.bundles ?? 0
      const afterCubic = roundTo(currentCubic - group.cubic, 4)
      const afterBundles = currentBundles - group.bundles

      if (afterCubic < 0 || afterBundles < 0) {
        problems.push(
          `无法恢复：${group.species}（等级 ${group.grade || '—'}）` +
            `厚${group.thickness}×宽${group.width}×长${group.length}，` +
            `当前库存 ${currentCubic} 立方 / ${currentBundles} 件，` +
            `恢复这张出库单后会变成 ${afterCubic} 立方 / ${afterBundles} 件，库存不能为负`,
        )
      }
    }

    if (problems.length > 0) {
      const error = new Error(problems.join('\n'))
      error.status = 400
      throw error
    }
  }

  restoreItemsStmt[type].run(id)
  restoreOrderStmt[type].run(id)
  return order
})

router.post('/restore', (req, res) => {
  const type = String(req.body?.type ?? '')
  const id = Number(req.body?.id)

  if (type !== 'in' && type !== 'out') {
    return res.status(400).json({ error: '单据类型不合法' })
  }
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '单据 ID 不合法' })
  }

  try {
    restoreOrder(type, id)
    res.json({ ok: true })
  } catch (err) {
    if (err.status === 400 || err.status === 404) {
      return res.status(err.status).json({ error: err.message })
    }
    res.status(500).json({ error: err.message })
  }
})

/* ---------- 彻底删除 ---------- */

const purgeOrderStmt = {
  in: db.prepare(`DELETE FROM inbound_orders WHERE id = ? AND deleted_at IS NOT NULL`),
  out: db.prepare(`DELETE FROM outbound_orders WHERE id = ? AND deleted_at IS NOT NULL`),
}

const purgeItemsStmt = {
  in: db.prepare(`DELETE FROM order_items WHERE order_type = 'in' AND order_id = ?`),
  out: db.prepare(`DELETE FROM order_items WHERE order_type = 'out' AND order_id = ?`),
}

// 明细本来就是删除状态，物理删掉不影响任何库存数字
const purgeOrder = db.transaction((type, id) => {
  const order = findDeletedStmt[type].get(id)
  if (!order) {
    const error = new Error('回收站里没有这张单据（可能已经恢复或彻底删除了）')
    error.status = 404
    throw error
  }

  purgeItemsStmt[type].run(id)
  purgeOrderStmt[type].run(id)
  return order
})

router.delete('/:type/:id', (req, res) => {
  const type = String(req.params.type)
  const id = Number(req.params.id)

  if (type !== 'in' && type !== 'out') {
    return res.status(400).json({ error: '单据类型不合法' })
  }
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '单据 ID 不合法' })
  }

  try {
    purgeOrder(type, id)
    res.json({ ok: true })
  } catch (err) {
    if (err.status === 400 || err.status === 404) {
      return res.status(err.status).json({ error: err.message })
    }
    res.status(500).json({ error: err.message })
  }
})

export default router
