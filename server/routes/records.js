import express from 'express'
import { db } from '../db.js'

const router = express.Router()

const roundTo = (value, digits) => Number(value.toFixed(digits))

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000

/**
 * 明细行级别（一行 = 一个 order_items），单头信息按 order_type 分别取
 * 入库取 supplier、出库取 customer 作为 partner
 */
const baseFrom = `
  FROM order_items i
  LEFT JOIN inbound_orders  oi ON i.order_type = 'in'  AND oi.id = i.order_id
  LEFT JOIN outbound_orders oo ON i.order_type = 'out' AND oo.id = i.order_id
`

const listSql = (where) => `
  SELECT i.id                                  AS record_id,
         COALESCE(oi.order_no, oo.order_no)    AS order_no,
         i.order_type,
         COALESCE(oi.order_date, oo.order_date) AS order_date,
         i.created_at,
         COALESCE(oi.supplier, oo.customer)    AS partner,
         i.species,
         i.grade,
         i.thickness,
         i.width,
         i.length,
         i.pieces,
         i.bundles,
         i.cubic,
         i.unit_price,
         i.amount
  ${baseFrom}
  ${where}
  ORDER BY i.created_at DESC, i.id DESC
  LIMIT ? OFFSET ?
`

const countSql = (where) => `SELECT COUNT(*) AS total ${baseFrom} ${where}`

function buildWhere(query) {
  const conditions = []
  const params = []

  const type = String(query.type ?? '').trim()
  if (type === 'in' || type === 'out') {
    conditions.push(`i.order_type = ?`)
    params.push(type)
  }

  if (query.date_from) {
    conditions.push(`COALESCE(oi.order_date, oo.order_date) >= ?`)
    params.push(String(query.date_from))
  }
  if (query.date_to) {
    conditions.push(`COALESCE(oi.order_date, oo.order_date) <= ?`)
    params.push(String(query.date_to))
  }

  const species = String(query.species ?? '').trim()
  if (species) {
    conditions.push(`i.species LIKE ?`)
    params.push(`%${species}%`)
  }

  const partner = String(query.partner ?? '').trim()
  if (partner) {
    conditions.push(`COALESCE(oi.supplier, oo.customer) LIKE ?`)
    params.push(`%${partner}%`)
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  }
}

// 出入库流水（明细行级别，支持多条件筛选 + 分页）
router.get('/', (req, res) => {
  const { where, params } = buildWhere(req.query)

  const rawLimit = Number(req.query.limit)
  const rawOffset = Number(req.query.offset)
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
      : DEFAULT_LIMIT
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0

  const total = db.prepare(countSql(where)).get(...params).total ?? 0
  const rows = db.prepare(listSql(where)).all(...params, limit, offset)

  res.json({
    total,
    limit,
    offset,
    records: rows.map((row) => ({
      record_id: row.record_id,
      order_no: row.order_no,
      order_type: row.order_type,
      order_date: row.order_date,
      created_at: row.created_at,
      partner: row.partner,
      species: row.species,
      grade: row.grade ?? '',
      thickness: row.thickness,
      width: row.width,
      length: row.length,
      pieces: row.pieces,
      bundles: row.bundles,
      cubic: roundTo(row.cubic ?? 0, 4),
      unit_price: row.unit_price ?? 0,
      amount: roundTo(row.amount ?? 0, 2),
    })),
  })
})

export default router
