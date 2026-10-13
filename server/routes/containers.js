import express from 'express'
import { db } from '../db.js'
import { pageParams } from '../utils/paging.js'

const router = express.Router()

const roundTo = (value, digits) => Number((value ?? 0).toFixed(digits))

function todayLocal() {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * 柜列表：带上「共几包 / 在库几包 / 已出几包 / 立方」，
 * 一眼能看出哪个柜的货还剩多少。
 */
const listSql = (where) => `
  SELECT c.*,
         COUNT(b.id)                                            AS bale_total,
         SUM(CASE WHEN b.status = 'in_stock' THEN 1 ELSE 0 END)  AS bale_in_stock,
         SUM(CASE WHEN b.status = 'shipped'  THEN 1 ELSE 0 END)  AS bale_shipped,
         ROUND(COALESCE(SUM(CASE WHEN b.status = 'in_stock' THEN b.cubic ELSE 0 END), 0), 4)
                                                                AS cubic_in_stock
    FROM containers c
    LEFT JOIN bales b ON b.container_id = c.id
   WHERE c.deleted_at IS NULL ${where}
   GROUP BY c.id
   ORDER BY c.arrive_date DESC, c.id DESC
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
    conditions.push(`AND (c.container_no LIKE ? OR c.contract_no LIKE ?)`)
    params.push(keyword, keyword)
  }

  const supplier = like(req.query.supplier)
  if (supplier) {
    conditions.push(`AND c.supplier LIKE ?`)
    params.push(supplier)
  }

  if (req.query.date_from) {
    conditions.push(`AND c.arrive_date >= ?`)
    params.push(String(req.query.date_from))
  }
  if (req.query.date_to) {
    conditions.push(`AND c.arrive_date <= ?`)
    params.push(String(req.query.date_to))
  }

  const where = conditions.join(' ')
  const total = Number(
    db
      .prepare(
        `SELECT COUNT(*) AS total FROM containers c
          WHERE c.deleted_at IS NULL ${where}`,
      )
      .get(...params)?.total ?? 0,
  )
  const { limit, offset } = pageParams(req.query)

  const rows = db
    .prepare(`${listSql(where)} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset)
    .map((row) => ({
      id: row.id,
      container_no: row.container_no,
      contract_no: row.contract_no ?? '',
      bl_no: row.bl_no ?? '',
      supplier: row.supplier ?? '',
      arrive_date: row.arrive_date ?? '',
      remark: row.remark ?? '',
      bale_total: row.bale_total ?? 0,
      bale_in_stock: row.bale_in_stock ?? 0,
      bale_shipped: row.bale_shipped ?? 0,
      cubic_in_stock: roundTo(row.cubic_in_stock ?? 0, 4),
      created_at: row.created_at,
    }))

  res.json({ total, limit, offset, rows })
})

/** 入库/出库表单选择柜时用的简表 */
router.get('/options', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, container_no, contract_no, bl_no, supplier, arrive_date
         FROM containers
        WHERE deleted_at IS NULL
        ORDER BY arrive_date DESC, id DESC
        LIMIT 200`,
    )
    .all()

  res.json(rows)
})

const insertContainer = db.prepare(
  `INSERT INTO containers (container_no, contract_no, bl_no, supplier, arrive_date, remark)
   VALUES (@container_no, @contract_no, @bl_no, @supplier, @arrive_date, @remark)`,
)

const updateContainerStmt = db.prepare(
  `UPDATE containers
      SET container_no = ?, contract_no = ?, bl_no = ?, supplier = ?,
          arrive_date = ?, remark = ?
    WHERE id = ? AND deleted_at IS NULL`,
)

const findByNoStmt = db.prepare(
  `SELECT * FROM containers WHERE container_no = ? AND deleted_at IS NULL`,
)
const findByIdStmt = db.prepare(
  `SELECT * FROM containers WHERE id = ? AND deleted_at IS NULL`,
)

function readBody(body) {
  return {
    container_no: String(body?.container_no ?? '').trim(),
    contract_no: String(body?.contract_no ?? '').trim(),
    bl_no: String(body?.bl_no ?? '').trim(),
    supplier: String(body?.supplier ?? '').trim(),
    arrive_date: body?.arrive_date ? String(body.arrive_date) : todayLocal(),
    remark: String(body?.remark ?? '').trim(),
  }
}

// 新建柜
router.post('/', (req, res) => {
  const data = readBody(req.body)
  if (!data.container_no) {
    return res.status(400).json({ error: '柜号不能为空' })
  }
  if (findByNoStmt.get(data.container_no)) {
    return res.status(400).json({ error: `柜号 ${data.container_no} 已存在` })
  }

  try {
    const { lastInsertRowid } = insertContainer.run({
      ...data,
      contract_no: data.contract_no || null,
      bl_no: data.bl_no || null,
      supplier: data.supplier || null,
      remark: data.remark || null,
    })
    res.json({ ok: true, id: Number(lastInsertRowid), container_no: data.container_no })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 修改柜（合同号、提单号写错了可以直接改）
router.put('/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!findByIdStmt.get(id)) {
    return res.status(404).json({ error: '柜不存在' })
  }

  const data = readBody(req.body)
  if (!data.container_no) {
    return res.status(400).json({ error: '柜号不能为空' })
  }

  const duplicate = db
    .prepare(
      `SELECT id FROM containers
        WHERE container_no = ? AND deleted_at IS NULL AND id <> ?`,
    )
    .get(data.container_no, id)
  if (duplicate) {
    return res.status(400).json({ error: `柜号 ${data.container_no} 已存在` })
  }

  try {
    updateContainerStmt.run(
      data.container_no,
      data.contract_no || null,
      data.bl_no || null,
      data.supplier || null,
      data.arrive_date,
      data.remark || null,
      id,
    )
    res.json({ ok: true, id, container_no: data.container_no })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 删除柜：柜里还有码单就不让删，避免货凭空消失
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!findByIdStmt.get(id)) {
    return res.status(404).json({ error: '柜不存在' })
  }

  const count = Number(
    db.prepare(`SELECT COUNT(*) AS total FROM bales WHERE container_id = ?`).get(id)
      ?.total ?? 0,
  )
  if (count > 0) {
    return res.status(400).json({
      error: `这个柜下面还有 ${count} 个码单，先处理完这些货再删柜`,
    })
  }

  db.prepare(
    `UPDATE containers SET deleted_at = datetime('now', 'localtime')
      WHERE id = ? AND deleted_at IS NULL`,
  ).run(id)
  res.json({ ok: true })
})

export default router
