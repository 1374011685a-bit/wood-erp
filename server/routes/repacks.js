import express from 'express'
import { db } from '../db.js'
import { pageParams } from '../utils/paging.js'
import { calcAmountCents, toCents, fromCents } from '../utils/cubic.js'
import {
  baleItemsStmt,
  getBale,
  normalizeBaleItems,
  replaceBaleItems,
} from './bales.js'

const router = express.Router()

const roundTo = (value, digits) => Number((value ?? 0).toFixed(digits))

function todayLocal() {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** 改包单号：GB + 日期 + 4 位流水 */
function buildRepackNo(repackDate) {
  const prefix = `GB${(repackDate || todayLocal()).replace(/-/g, '')}`
  const last = db
    .prepare(
      `SELECT repack_no FROM repacks WHERE repack_no LIKE ?
        ORDER BY repack_no DESC LIMIT 1`,
    )
    .get(`${prefix}%`)
  const next = last ? Number(last.repack_no.slice(prefix.length)) + 1 : 1
  return `${prefix}${String(next).padStart(4, '0')}`
}

/**
 * 改前这一包的成本（分）。
 * 规格行的单价从对应的入库明细里取——同一包里几个规格各自算各自的。
 */
const priceOfItemStmt = db.prepare(
  `SELECT COALESCE(unit_price_cents, ROUND(unit_price * 100)) AS cents
     FROM order_items
    WHERE order_type = 'in' AND order_id = ? AND deleted_at IS NULL
      AND COALESCE(species, '') = COALESCE(?, '')
      AND COALESCE(grade, '') = COALESCE(?, '')
      AND thickness = ? AND width = ? AND length = ? AND pieces = ?
    ORDER BY id LIMIT 1`,
)

function beforeCostCents(bale) {
  if (!bale.inbound_order_id) return 0
  let cents = 0
  for (const item of baleItemsStmt.all(bale.id)) {
    cents += calcAmountCents(
      roundTo(item.cubic ?? 0, 4),
      itemPriceCents(bale.inbound_order_id, item),
    )
  }
  return cents
}

/** 规格行对应的入库单价（分），找不到就是 0 */
function itemPriceCents(orderId, item) {
  if (!orderId) return 0
  const row = priceOfItemStmt.get(
    orderId,
    item.species,
    item.grade,
    item.thickness,
    item.width,
    item.length,
    item.pieces,
  )
  return Number(row?.cents ?? 0)
}

const snapshot = (items, centsList = []) =>
  JSON.stringify(
    items.map((item, index) => ({
      species: item.species ?? '',
      grade: item.grade ?? '',
      thickness: item.thickness,
      width: item.width,
      length: item.length,
      pieces: item.pieces,
      cubic: roundTo(item.cubic ?? 0, 4),
      // 记下这一行当时的成本单价，撤销改包时按原价还原
      unit_price: fromCents(centsList[index] ?? 0),
    })),
  )

const parseSnapshot = (text) => {
  if (!text) return []
  try {
    const list = JSON.parse(text)
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

const toApi = (row) => ({
  id: row.id,
  repack_no: row.repack_no,
  repack_date: row.repack_date,
  bale_id: row.bale_id,
  barcode: row.barcode ?? '',
  bale_no: row.bale_no ?? '',
  summary: row.summary ?? '',
  remark: row.remark ?? '',
  before_cubic: roundTo(row.before_cubic ?? 0, 4),
  before_amount: fromCents(row.before_amount_cents ?? 0),
  after_cubic: roundTo(row.after_cubic ?? 0, 4),
  after_amount: fromCents(row.after_amount_cents ?? 0),
  loss_cubic: roundTo(row.loss_cubic ?? 0, 4),
  loss_amount: fromCents(
    Number(row.after_amount_cents ?? 0) - Number(row.before_amount_cents ?? 0),
  ),
  price_pinned: Boolean(row.price_pinned),
  before_items: parseSnapshot(row.before_json),
  after_items: parseSnapshot(row.after_json),
  bl_no: row.container_no ?? '',
  contract_no: row.contract_no ?? '',
  created_at: row.created_at,
})

/* ---------- 改包记录列表 ---------- */

router.get('/', (req, res) => {
  const conditions = []
  const params = []

  const like = (value) => {
    const text = String(value ?? '').trim()
    return text ? `%${text}%` : ''
  }

  if (req.query.date_from) {
    conditions.push(`AND repack_date >= ?`)
    params.push(String(req.query.date_from))
  }
  if (req.query.date_to) {
    conditions.push(`AND repack_date <= ?`)
    params.push(String(req.query.date_to))
  }
  const species = like(req.query.species)
  if (species) {
    conditions.push(`AND before_json LIKE ?`)
    params.push(species)
  }
  const keyword = like(req.query.keyword)
  if (keyword) {
    conditions.push(`AND (repack_no LIKE ? OR barcode LIKE ? OR summary LIKE ?)`)
    params.push(keyword, keyword, keyword)
  }

  const where = conditions.join(' ')
  const total = Number(
    db
      .prepare(`SELECT COUNT(*) AS total FROM repacks WHERE 1 = 1 ${where}`)
      .get(...params)?.total ?? 0,
  )
  const sums = db
    .prepare(
      `SELECT ROUND(COALESCE(SUM(before_cubic), 0), 4)      AS before_cubic,
              ROUND(COALESCE(SUM(after_cubic), 0), 4)       AS after_cubic,
              ROUND(COALESCE(SUM(loss_cubic), 0), 4)        AS loss_cubic,
              COALESCE(SUM(before_amount_cents), 0)         AS before_cents,
              COALESCE(SUM(after_amount_cents), 0)          AS after_cents
         FROM repacks WHERE 1 = 1 ${where}`,
    )
    .get(...params)

  const { limit, offset } = pageParams(req.query)
  const rows = db
    .prepare(
      `SELECT * FROM repacks WHERE 1 = 1 ${where}
        ORDER BY repack_date DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset)
    .map(toApi)

  res.json({
    total,
    limit,
    offset,
    rows,
    sums: {
      before_cubic: roundTo(sums?.before_cubic ?? 0, 4),
      after_cubic: roundTo(sums?.after_cubic ?? 0, 4),
      loss_cubic: roundTo(sums?.loss_cubic ?? 0, 4),
      before_amount: fromCents(sums?.before_cents ?? 0),
      after_amount: fromCents(sums?.after_cents ?? 0),
    },
  })
})

/* ---------- 可以做改包的包（在库的） ---------- */

router.get('/bales', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT b.id, b.bale_no, b.barcode, b.cubic, b.pieces, b.status,
              s.bl_no, s.contract_no
         FROM bales b
         LEFT JOIN shipments s ON s.id = b.shipment_id
        WHERE b.status = 'in_stock'
        ORDER BY b.id DESC
        LIMIT 500`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      bale_no: row.bale_no ?? '',
      barcode: row.barcode ?? row.bale_no ?? '',
      cubic: roundTo(row.cubic ?? 0, 4),
      pieces: row.pieces ?? 0,
      bl_no: row.bl_no ?? '',
      contract_no: row.contract_no ?? '',
      items: baleItemsStmt.all(row.id).map((item) => ({
        species: item.species ?? '',
        grade: item.grade ?? '',
        thickness: item.thickness,
        width: item.width,
        length: item.length,
        pieces: item.pieces,
        cubic: roundTo(item.cubic ?? 0, 4),
        unit_price: fromCents(itemPriceCents(row.inbound_order_id, item)),
      })),
    }))

  res.json(rows)
})

/* ---------- 改包 ---------- */

const insertRepack = db.prepare(
  `INSERT INTO repacks
     (repack_no, repack_date, bale_id, barcode, bale_no, container_no,
      summary, remark, before_cubic, before_amount_cents,
      after_cubic, after_amount_cents, loss_cubic, price_pinned,
      before_json, after_json, bl_no, contract_no)
   VALUES
     (@repack_no, @repack_date, @bale_id, @barcode, @bale_no, @container_no,
      @summary, @remark, @before_cubic, @before_amount_cents,
      @after_cubic, @after_amount_cents, @loss_cubic, @price_pinned,
      @before_json, @after_json, @bl_no, @contract_no)`,
)

const createRepack = db.transaction((payload) => {
  const bale = getBale(payload.baleId)
  if (!bale) {
    const error = new Error('这一包不存在')
    error.status = 404
    throw error
  }
  if (bale.status !== 'in_stock') {
    const error = new Error(
      `条码号 ${bale.barcode || bale.bale_no} 已经出库了，不能改包`,
    )
    error.status = 400
    throw error
  }

  const beforeItems = baleItemsStmt.all(bale.id)
  const beforeCubic = roundTo(
    beforeItems.reduce((sum, item) => sum + (item.cubic ?? 0), 0),
    4,
  )
  const beforeCents = beforeCostCents(bale)

  const afterCubic = roundTo(
    payload.items.reduce((sum, item) => sum + item.cubic, 0),
    4,
  )

  /**
   * 改后单价：填了就以用户填的为准（不再随改前成本变），
   * 没填就按「改前总成本 ÷ 改后总方数」摊到每一行。
   */
  const pinned = payload.prices.some((price) => Number(price) > 0)
  const derivedCents = afterCubic > 0 ? Math.round(beforeCents / afterCubic) : 0
  // 每一行最终用哪个成本单价（填了用填的，没填用摊出来的）
  const afterPriceCents = payload.items.map((_item, index) =>
    pinned ? toCents(payload.prices[index] ?? 0) : derivedCents,
  )
  const afterCents = payload.items.reduce((sum, item, index) => {
    const cents = afterPriceCents[index]
    return sum + calcAmountCents(item.cubic, cents)
  }, 0)

  // 提单号：柜已经不要了，直接从提单上取
  const shipment = bale.shipment_id
    ? db.prepare(`SELECT bl_no FROM shipments WHERE id = ?`).get(bale.shipment_id)
    : null

  const { lastInsertRowid } = insertRepack.run({
    repack_no: payload.repackNo,
    repack_date: payload.repackDate,
    bale_id: bale.id,
    barcode: bale.barcode ?? bale.bale_no ?? '',
    bale_no: bale.bale_no ?? '',
    container_no: shipment?.bl_no ?? null,
    summary: payload.summary || null,
    remark: payload.remark || null,
    before_cubic: beforeCubic,
    before_amount_cents: beforeCents,
    after_cubic: afterCubic,
    after_amount_cents: afterCents,
    loss_cubic: roundTo(afterCubic - beforeCubic, 4),
    price_pinned: pinned ? 1 : 0,
    before_json: snapshot(
      beforeItems,
      beforeItems.map((item) => itemPriceCents(bale.inbound_order_id, item)),
    ),
    after_json: snapshot(payload.items, afterPriceCents),
    bl_no: payload.blNo || null,
    contract_no: payload.contractNo || null,
  })

  // 规格换掉，入库明细一起同步（库存跟着变）；
  // 成本单价一并写进去，库存金额才不会因为改包变成 0
  replaceBaleItems(
    bale,
    payload.items.map((item, index) => ({
      ...item,
      unit_price_cents: afterPriceCents[index],
    })),
  )

  return { id: Number(lastInsertRowid), repack_no: payload.repackNo }
})

router.post('/', (req, res) => {
  const body = req.body ?? {}
  const baleId = Number(body.bale_id)
  if (!Number.isInteger(baleId) || baleId <= 0) {
    return res.status(400).json({ error: '请先选择要改的包' })
  }

  const rawItems = Array.isArray(body.after_items) ? body.after_items : []
  const { items, problems } = normalizeBaleItems(rawItems)
  if (problems.length > 0) {
    return res.status(400).json({ error: problems.join('\n') })
  }

  try {
    const result = createRepack({
      repackNo: buildRepackNo(body.repack_date),
      repackDate: body.repack_date ? String(body.repack_date) : todayLocal(),
      baleId,
      summary: String(body.summary ?? '').trim(),
      remark: String(body.remark ?? '').trim(),
      blNo: String(body.bl_no ?? '').trim(),
      contractNo: String(body.contract_no ?? '').trim(),
      items,
      prices: rawItems.map((item) => item?.unit_price),
    })
    res.json(result)
  } catch (err) {
    if (err.status === 400 || err.status === 404) {
      return res.status(err.status).json({ error: err.message })
    }
    res.status(500).json({ error: err.message })
  }
})

/* ---------- 撤销改包 ---------- */

const removeRepack = db.transaction((id) => {
  const row = db.prepare(`SELECT * FROM repacks WHERE id = ?`).get(id)
  if (!row) {
    const error = new Error('这条改包记录不存在')
    error.status = 404
    throw error
  }

  const bale = row.bale_id ? getBale(row.bale_id) : null
  if (bale) {
    if (bale.status !== 'in_stock') {
      const error = new Error(
        `条码号 ${bale.barcode || bale.bale_no} 已经出库了，要撤销请先撤销出库单`,
      )
      error.status = 400
      throw error
    }
    // 把规格改回改包前的样子
    const back = parseSnapshot(row.before_json)
    if (back.length > 0) {
      replaceBaleItems(
        bale,
        back.map((line) => ({
          ...line,
          unit_price_cents: toCents(line.unit_price ?? 0),
        })),
      )
    }
  }

  db.prepare(`DELETE FROM repacks WHERE id = ?`).run(id)
  return { repack_no: row.repack_no }
})

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '改包记录 ID 不合法' })
  }
  try {
    res.json({ ok: true, ...removeRepack(id) })
  } catch (err) {
    if (err.status === 400 || err.status === 404) {
      return res.status(err.status).json({ error: err.message })
    }
    res.status(500).json({ error: err.message })
  }
})

export default router
