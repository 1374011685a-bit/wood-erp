import express from 'express'
import { db } from '../db.js'

const router = express.Router()

const roundTo = (value, digits) => Number(value.toFixed(digits))

/**
 * 实时汇总库存（不建库存表）：按 品名 + 等级 + 厚度 + 宽度 + 长度 归组
 * 库存 = 入库合计 - 出库合计；立方、件数、片数分别汇总
 * 最近入库单价：取该规格最新一条入库明细的 unit_price 作为参考价
 */
const stockSql = (hasSpeciesFilter) => `
  SELECT i.species,
         i.grade,
         i.thickness,
         i.width,
         i.length,
         SUM(CASE WHEN i.order_type = 'in' THEN i.cubic   ELSE -i.cubic   END) AS total_cubic,
         SUM(CASE WHEN i.order_type = 'in' THEN i.bundles ELSE -i.bundles END) AS total_bundles,
         SUM(CASE WHEN i.order_type = 'in'
                  THEN i.pieces * i.bundles
                  ELSE -i.pieces * i.bundles END) AS total_pieces,
         (SELECT COALESCE(s.unit_price_cents, ROUND(s.unit_price * 100)) / 100.0
            FROM order_items s
           WHERE s.order_type = 'in'
             AND COALESCE(s.species, '') = COALESCE(i.species, '')
             AND COALESCE(s.grade, '')   = COALESCE(i.grade, '')
             AND s.thickness = i.thickness
             AND s.width     = i.width
             AND s.length    = i.length
           ORDER BY s.id DESC
           LIMIT 1) AS last_unit_price
    FROM order_items i
   ${hasSpeciesFilter ? `WHERE i.species LIKE ?` : ''}
   GROUP BY i.species, i.grade, i.thickness, i.width, i.length
  HAVING SUM(CASE WHEN i.order_type = 'in' THEN i.cubic ELSE -i.cubic END) > 0
   ORDER BY i.species, i.grade, i.thickness, i.width, i.length
`

// 库存列表（可选按品名模糊筛选）
router.get('/', (req, res) => {
  const species = String(req.query.species ?? '').trim()
  const params = species ? [`%${species}%`] : []

  const rows = db.prepare(stockSql(Boolean(species))).all(...params)

  res.json(
    rows.map((row) => ({
      species: row.species,
      grade: row.grade ?? '',
      thickness: row.thickness,
      width: row.width,
      length: row.length,
      total_bundles: row.total_bundles ?? 0,
      total_pieces: row.total_pieces ?? 0,
      total_cubic: roundTo(row.total_cubic ?? 0, 4),
      last_unit_price: row.last_unit_price ?? null,
    })),
  )
})

export default router
