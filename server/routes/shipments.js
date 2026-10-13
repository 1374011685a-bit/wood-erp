import express from 'express'
import { db } from '../db.js'
import { pageParams } from '../utils/paging.js'
import { contractError } from '../utils/contractGate.js'
import { shipmentBaleInfo } from './bales.js'

const router = express.Router()

const roundTo = (value, digits) => Number((value ?? 0).toFixed(4))

function todayLocal() {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

const findShipmentStmt = db.prepare(
  `SELECT * FROM shipments WHERE id = ? AND deleted_at IS NULL`,
)
const findByNoStmt = db.prepare(
  `SELECT * FROM shipments WHERE bl_no = ? AND deleted_at IS NULL`,
)

/**
 * 提单列表：带出这一票下面的包数、在库包数、立方、柜数，
 * 到货录入时一眼能看出哪一票还没录完。
 */
const listSql = (where) => `
  SELECT s.*,
         (SELECT COUNT(*) FROM bales b
           WHERE b.shipment_id = s.id AND b.deleted_at IS NULL)                               AS bale_total,
         (SELECT COUNT(*) FROM bales b
           WHERE b.shipment_id = s.id AND b.status = 'in_stock' AND b.deleted_at IS NULL)     AS bale_in_stock,
         (SELECT ROUND(COALESCE(SUM(b.cubic), 0), 4) FROM bales b
           WHERE b.shipment_id = s.id AND b.deleted_at IS NULL)                               AS bale_cubic,
         (SELECT COUNT(DISTINCT b.box_no) FROM bales b
           WHERE b.shipment_id = s.id AND b.deleted_at IS NULL
             AND b.box_no IS NOT NULL AND TRIM(b.box_no) <> '')      AS box_count
    FROM shipments s
   WHERE s.deleted_at IS NULL ${where}
   ORDER BY s.arrival_date DESC, s.id DESC
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
    conditions.push(`AND (s.bl_no LIKE ? OR s.contract_no LIKE ?)`)
    params.push(keyword, keyword)
  }
  const supplier = like(req.query.supplier)
  if (supplier) {
    conditions.push(`AND s.supplier LIKE ?`)
    params.push(supplier)
  }
  if (req.query.date_from) {
    conditions.push(`AND s.arrival_date >= ?`)
    params.push(String(req.query.date_from))
  }
  if (req.query.date_to) {
    conditions.push(`AND s.arrival_date <= ?`)
    params.push(String(req.query.date_to))
  }

  const where = conditions.join(' ')
  const total = Number(
    db
      .prepare(
        `SELECT COUNT(*) AS total FROM shipments s
          WHERE s.deleted_at IS NULL ${where}`,
      )
      .get(...params)?.total ?? 0,
  )
  const { limit, offset } = pageParams(req.query)

  const rows = db
    .prepare(`${listSql(where)} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset)
    .map((row) => ({
      id: row.id,
      bl_no: row.bl_no,
      contract_no: row.contract_no ?? '',
      supplier: row.supplier ?? '',
      arrival_date: row.arrival_date ?? '',
      remark: row.remark ?? '',
      bale_total: row.bale_total ?? 0,
      bale_in_stock: row.bale_in_stock ?? 0,
      bale_cubic: roundTo(row.bale_cubic ?? 0, 4),
      box_count: row.box_count ?? 0,
      created_at: row.created_at,
    }))

  res.json({ total, limit, offset, rows })
})

/**
 * 提单选项（入库表单选提单用）。
 * 带上「这票已经贴了几张码单、下一个条码号从几开始」，和提单卡片上的数一致。
 */
router.get('/options', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, bl_no, contract_no, supplier, arrival_date
         FROM shipments
        WHERE deleted_at IS NULL
        ORDER BY arrival_date DESC, id DESC
        LIMIT 200`,
    )
    .all()

  res.json(
    rows.map((row) => {
      const info = shipmentBaleInfo(row.id)
      return {
        ...row,
        bale_count: info.count,
        box_count: info.box_count,
        next_seq: info.next_seq,
      }
    }),
  )
})

/** 提单下的柜（柜已下线，仅老接口保留） */
router.get('/:id/containers', (req, res) => {
  const id = Number(req.params.id)
  if (!findShipmentStmt.get(id)) {
    return res.status(404).json({ error: '提单不存在' })
  }

  const rows = db
    .prepare(
      `SELECT c.id, c.container_no, c.arrive_date,
              (SELECT COUNT(*) FROM bales b WHERE b.container_id = c.id) AS bale_total,
              (SELECT COUNT(*) FROM bales b
                WHERE b.container_id = c.id AND b.status = 'in_stock')   AS bale_in_stock
         FROM containers c
        WHERE c.shipment_id = ? AND c.deleted_at IS NULL
        ORDER BY c.container_no`,
    )
    .all(id)

  res.json(rows)
})

/* ---------- 新建提单（可以一次把这一票的柜号都填上） ---------- */

const insertShipment = db.prepare(
  `INSERT INTO shipments (bl_no, contract_no, supplier, arrival_date, remark)
   VALUES (@bl_no, @contract_no, @supplier, @arrival_date, @remark)`,
)
const insertContainer = db.prepare(
  `INSERT INTO containers (container_no, shipment_id, contract_no, bl_no, supplier, arrive_date)
   VALUES (@container_no, @shipment_id, @contract_no, @bl_no, @supplier, @arrive_date)`,
)

const createShipment = db.transaction(({ blNo, contractNo, supplier, arrivalDate, remark, containerNos }) => {
  const { lastInsertRowid } = insertShipment.run({
    bl_no: blNo,
    contract_no: contractNo || null,
    supplier: supplier || null,
    arrival_date: arrivalDate,
    remark: remark || null,
  })
  const shipmentId = Number(lastInsertRowid)

  const created = []
  for (const containerNo of containerNos) {
    if (findContainerByNo.get(containerNo)) {
      const error = new Error(`柜号 ${containerNo} 已经存在，请检查`)
      error.status = 400
      throw error
    }
    insertContainer.run({
      container_no: containerNo,
      shipment_id: shipmentId,
      contract_no: contractNo || null,
      bl_no: blNo,
      supplier: supplier || null,
      arrive_date: arrivalDate,
    })
    created.push(containerNo)
  }

  return { id: shipmentId, bl_no: blNo }
})

const findContainerByNo = db.prepare(
  `SELECT id FROM containers WHERE container_no = ? AND deleted_at IS NULL`,
)

router.post('/', (req, res) => {
  const body = req.body ?? {}
  const blNo = String(body.bl_no ?? '').trim()
  const contractNo = String(body.contract_no ?? '').trim()
  const supplier = String(body.supplier ?? '').trim()
  const arrivalDate = body.arrival_date ? String(body.arrival_date) : todayLocal()
  const remark = String(body.remark ?? '').trim()

  // 柜号：已经不作为一层了，这里只保留给老数据用（新流程不填）
  const rawContainers = Array.isArray(body.container_nos)
    ? body.container_nos
    : String(body.container_nos ?? '').split(/[\s,，、;；]+/)
  const containerNos = rawContainers
    .map((item) => String(item).trim())
    .filter(Boolean)

  if (!blNo) return res.status(400).json({ error: '提单号不能为空' })
  if (findByNoStmt.get(blNo)) {
    return res.status(400).json({ error: `提单号 ${blNo} 已存在` })
  }
  const contractProblem = contractError(contractNo)
  if (contractProblem) return res.status(400).json({ error: contractProblem })

  try {
    res.json(
      createShipment({
        blNo,
        contractNo,
        supplier,
        arrivalDate,
        remark,
        containerNos,
      }),
    )
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message })
    if (String(err.message).includes('UNIQUE')) {
      return res.status(400).json({ error: `提单号或柜号重复：${err.message}` })
    }
    res.status(500).json({ error: err.message })
  }
})

/** 给已有提单补柜（后面又到了几个柜的情况） */
router.post('/:id/containers', (req, res) => {
  const id = Number(req.params.id)
  const shipment = findShipmentStmt.get(id)
  if (!shipment) return res.status(404).json({ error: '提单不存在' })

  const raw = Array.isArray(req.body?.container_nos)
    ? req.body.container_nos
    : String(req.body?.container_nos ?? '').split(/[\s,，、;；]+/)
  const containerNos = raw.map((item) => String(item).trim()).filter(Boolean)
  const created = []
  try {
    for (const containerNo of containerNos) {
      if (findContainerByNo.get(containerNo)) {
        return res.status(400).json({ error: `柜号 ${containerNo} 已经存在` })
      }
      insertContainer.run({
        container_no: containerNo,
        shipment_id: id,
        contract_no: shipment.contract_no,
        bl_no: shipment.bl_no,
        supplier: shipment.supplier,
        arrive_date: shipment.arrival_date,
      })
      created.push(containerNo)
    }
    res.json({ ok: true, containers: created })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * 删除提单：柜已经不是一层了，只看还有没有在库的包。
 * 有在库的包就不让删（货还在），全出完了才允许，连带把老柜记录一起软删掉。
 */
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!findShipmentStmt.get(id)) {
    return res.status(404).json({ error: '提单不存在' })
  }

  const inStock = Number(
    db
      .prepare(
        `SELECT COUNT(*) AS total FROM bales
          WHERE shipment_id = ? AND status = 'in_stock'`,
      )
      .get(id)?.total ?? 0,
  )
  if (inStock > 0) {
    return res.status(400).json({
      error: `这张提单下面还有 ${inStock} 包货在库，先出完或删掉再删提单`,
    })
  }

  db.prepare(
    `UPDATE containers SET deleted_at = datetime('now', 'localtime')
      WHERE shipment_id = ? AND deleted_at IS NULL`,
  ).run(id)
  db.prepare(
    `UPDATE shipments SET deleted_at = datetime('now', 'localtime')
      WHERE id = ? AND deleted_at IS NULL`,
  ).run(id)
  res.json({ ok: true })
})

export default router
