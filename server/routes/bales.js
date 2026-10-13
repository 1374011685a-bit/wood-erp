import express from 'express'
import { db } from '../db.js'
import { calcCubic } from '../utils/cubic.js'
import { pageParams } from '../utils/paging.js'

const router = express.Router()

const roundTo = (value, digits) => Number((value ?? 0).toFixed(digits))

/**
 * 码单列表：一包一条，带上柜号 / 合同号 / 出库单号，
 * 用来查「这包货还在不在、卖给了谁、属于哪个合同」。
 */
const listSql = (where) => `
  SELECT b.*,
         c.container_no,
         c.shipment_id,
         c.bl_no,
         c.contract_no,
         o.order_no AS outbound_order_no
    FROM bales b
    LEFT JOIN containers c      ON c.id = b.container_id
    LEFT JOIN outbound_orders o ON o.id = b.outbound_order_id
   WHERE 1 = 1 ${where}
   ORDER BY b.status = 'in_stock' DESC, b.id DESC
`

router.get('/', (req, res) => {
  const conditions = []
  const params = []

  const like = (value) => {
    const text = String(value ?? '').trim()
    return text ? `%${text}%` : ''
  }

  const keyword = like(req.query.keyword)
  if (keyword) {
    conditions.push(
      `AND (b.bale_no LIKE ? OR c.container_no LIKE ? OR c.contract_no LIKE ?)`,
    )
    params.push(keyword, keyword, keyword)
  }

  const status = String(req.query.status ?? '').trim()
  if (status === 'in_stock' || status === 'shipped') {
    conditions.push(`AND b.status = ?`)
    params.push(status)
  }

  const containerId = Number(req.query.container_id)
  if (Number.isInteger(containerId) && containerId > 0) {
    conditions.push(`AND b.container_id = ?`)
    params.push(containerId)
  }

  const shipmentId = Number(req.query.shipment_id)
  if (Number.isInteger(shipmentId) && shipmentId > 0) {
    conditions.push(`AND c.shipment_id = ?`)
    params.push(shipmentId)
  }

  const species = like(req.query.species)
  if (species) {
    conditions.push(`AND b.species LIKE ?`)
    params.push(species)
  }

  const where = conditions.join(' ')
  const countSql = `
    SELECT COUNT(*) AS total
      FROM bales b
      LEFT JOIN containers c ON c.id = b.container_id
     WHERE 1 = 1 ${where}
  `
  const total = Number(
    db.prepare(countSql).get(...params)?.total ?? 0,
  )
  const { limit, offset } = pageParams(req.query)

  const rows = db
    .prepare(`${listSql(where)} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset)
    .map((row) => ({
      id: row.id,
      bale_no: row.bale_no,
      container_id: row.container_id,
      container_no: row.container_no ?? '',
      shipment_id: row.shipment_id ?? null,
      bl_no: row.bl_no ?? '',
      contract_no: row.contract_no ?? '',
      inbound_order_id: row.inbound_order_id,
      outbound_order_id: row.outbound_order_id,
      outbound_order_no: row.outbound_order_no ?? '',
      species: row.species ?? '',
      grade: row.grade ?? '',
      thickness: row.thickness,
      width: row.width,
      length: row.length,
      pieces: row.pieces,
      cubic: roundTo(row.cubic ?? 0, 4),
      status: row.status,
      created_at: row.created_at,
      shipped_at: row.shipped_at,
    }))

  res.json({ total, limit, offset, rows })
})

/* ---------- 给入库单生成码单 ---------- */

/**
 * 码单号规则：<柜号>-<3 位流水>，例如 WH2026-01-001。
 * 没有柜的老流程就退化成 <入库单号>-<3 位>，保证唯一。
 * 二维码后一版再加，这里先把号生成好。
 */
export function buildBaleNo(containerNo, inboundOrderNo, sequence) {
  const prefix = containerNo || inboundOrderNo
  return `${prefix}-${String(sequence).padStart(3, '0')}`
}

/** 这个柜（或这张入库单）已经发到第几号了 */
export function nextBaleSequence(containerId, inboundOrderNo) {
  if (containerId) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS total FROM bales WHERE container_id = ?`,
      )
      .get(containerId)
    return Number(row?.total ?? 0) + 1
  }

  const row = db
    .prepare(
      `SELECT COUNT(*) AS total FROM bales
        WHERE container_id IS NULL AND inbound_order_id IN
              (SELECT id FROM inbound_orders WHERE order_no = ?)`,
    )
    .get(inboundOrderNo)
  return Number(row?.total ?? 0) + 1
}

const insertBale = db.prepare(
  `INSERT INTO bales
     (bale_no, container_id, inbound_order_id, species, grade,
      thickness, width, length, pieces, cubic, status)
   VALUES
     (@bale_no, @container_id, @inbound_order_id, @species, @grade,
      @thickness, @width, @length, @pieces, @cubic, 'in_stock')`,
)

const findBaleByNo = db.prepare(`SELECT * FROM bales WHERE bale_no = ?`)
const insertBaleItem = db.prepare(
  `INSERT INTO bale_items (bale_id, species, grade, thickness, width, length, pieces, cubic)
   VALUES (@bale_id, @species, @grade, @thickness, @width, @length, @pieces, @cubic)`,
)
const updateBaleSummary = db.prepare(
  `UPDATE bales
      SET cubic = ?,
          pieces = ?,
          species = COALESCE(species, ?),
          grade = COALESCE(grade, ?),
          thickness = COALESCE(thickness, ?),
          width = COALESCE(width, ?),
          length = COALESCE(length, ?)
    WHERE id = ?`,
)

/**
 * 把一行明细落到具体的包上。
 *
 * - 填了包号（支持 7 / 7-9 / 7,9,11）：每个包号对应一个码单，包号相同就表示
 *   「同一包里再录一个规格」，规格累加到这一包上；
 * - 没填包号：按「包数」自动往后编号（柜内连续）。
 */
export function createBalesForItem({
  item,
  containerId,
  containerNo,
  inboundOrderId,
  inboundOrderNo,
  baleLabels,
}) {
  const labels =
    Array.isArray(baleLabels) && baleLabels.length > 0
      ? baleLabels.map((label) => String(label).trim()).filter(Boolean)
      : null
  const bundles = labels ? labels.length : Math.round(Number(item.bundles ?? 0))
  if (!(bundles > 0)) return []

  let sequence = nextBaleSequence(containerId, inboundOrderNo)
  const cubicPerBale = roundTo(
    calcCubic(item.thickness, item.width, item.length, item.pieces, 1),
    4,
  )
  const created = []

  for (let i = 0; i < bundles; i += 1) {
    const baleNo = labels
      ? labels[i]
      : buildBaleNo(containerNo, inboundOrderNo, sequence)
    if (!labels) sequence += 1

    let bale = findBaleByNo.get(baleNo)
    if (bale) {
      if (bale.container_id !== (containerId ?? null)) {
        const error = new Error(`包号 ${baleNo} 已经出现在别的柜里，请检查包号`)
        error.status = 400
        throw error
      }
    } else {
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO bales
             (bale_no, container_id, inbound_order_id, species, grade,
              thickness, width, length, pieces, cubic, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_stock')`,
        )
        .run(
          baleNo,
          containerId ?? null,
          inboundOrderId,
          item.species,
          item.grade,
          item.thickness,
          item.width,
          item.length,
          item.pieces,
          cubicPerBale,
        )
      bale = { id: Number(lastInsertRowid) }
      created.push(baleNo)
    }

    // 规格行：一包可以有几个规格
    insertBaleItem.run({
      bale_id: bale.id,
      species: item.species,
      grade: item.grade,
      thickness: item.thickness,
      width: item.width,
      length: item.length,
      pieces: item.pieces,
      cubic: cubicPerBale,
    })

    if (labels) {
      // 同一包再录规格时，把这一包的总立方 / 总片数累加上去
      const totals = db
        .prepare(
          `SELECT ROUND(COALESCE(SUM(cubic), 0), 4) AS cubic,
                  COALESCE(SUM(pieces), 0)         AS pieces
             FROM bale_items WHERE bale_id = ?`,
        )
        .get(bale.id)
      updateBaleSummary.run(
        totals.cubic,
        totals.pieces,
        item.species,
        item.grade,
        item.thickness,
        item.width,
        item.length,
        bale.id,
      )
    }
  }

  return created
}


export default router
