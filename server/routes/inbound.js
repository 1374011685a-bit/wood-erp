import express from 'express'
import { db } from '../db.js'
import { calcCubic, calcAmount } from '../utils/cubic.js'
import { validateItems } from '../utils/validateItems.js'

const router = express.Router()

/** 本地日期 YYYY-MM-DD */
function todayLocal() {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * 单号规则：RK + YYYYMMDD + 当天 4 位流水
 * 日期取单据日期，未传则取今天；流水号按单号前缀倒序取最大值加一
 */
function buildOrderNo(orderDate) {
  const date = orderDate || todayLocal()
  const prefix = `RK${date.replace(/-/g, '')}`
  const last = db
    .prepare(
      `SELECT order_no FROM inbound_orders
        WHERE order_no LIKE ?
        ORDER BY order_no DESC
        LIMIT 1`,
    )
    .get(`${prefix}%`)

  const next = last ? Number(last.order_no.slice(prefix.length)) + 1 : 1
  return `${prefix}${String(next).padStart(4, '0')}`
}

function toNumber(value, fallback = 0) {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

/**
 * 明细标准化：cubic 与 amount 一律服务端重算，忽略前端传入的值
 * 片数、件数缺省为 1，单价缺省为 0；显式传 0 或负数不会被兜底成 1，交给字段校验拦下
 */
function optionalNumber(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback
  }
  return toNumber(value, fallback)
}

function normalizeItems(items) {
  return items.map((item) => {
    const thickness = toNumber(item.thickness)
    const width = toNumber(item.width)
    const length = toNumber(item.length)
    const pieces = optionalNumber(item.pieces, 1)
    const bundles = optionalNumber(item.bundles, 1)
    const unitPrice = toNumber(item.unit_price)
    const cubic = calcCubic(thickness, width, length, pieces, bundles)

    return {
      species: String(item.species ?? '').trim(),
      grade: String(item.grade ?? '').trim(),
      thickness,
      width,
      length,
      pieces,
      bundles,
      cubic,
      unit_price: unitPrice,
      amount: calcAmount(cubic, unitPrice),
    }
  })
}

const insertOrder = db.prepare(
  `INSERT INTO inbound_orders (order_no, supplier, order_date, remark)
   VALUES (?, ?, ?, ?)`,
)

const insertItem = db.prepare(
  `INSERT INTO order_items
     (order_id, order_type, species, grade, thickness, width, length,
      pieces, bundles, cubic, unit_price, amount)
   VALUES
     (@order_id, 'in', @species, @grade, @thickness, @width, @length,
      @pieces, @bundles, @cubic, @unit_price, @amount)`,
)

// 事务：先插单头，再批量插明细
const createInbound = db.transaction(({ orderNo, supplier, orderDate, remark, items }) => {
  const { lastInsertRowid } = insertOrder.run(
    orderNo,
    supplier,
    orderDate,
    remark || null,
  )
  const orderId = Number(lastInsertRowid)
  for (const item of items) {
    insertItem.run({ ...item, order_id: orderId })
  }
  return { id: orderId, order_no: orderNo }
})

// 新增入库单
router.post('/', (req, res) => {
  const body = req.body ?? {}
  const supplier = String(body.supplier ?? '').trim()
  const orderDate = body.order_date ? String(body.order_date) : todayLocal()
  const remark = body.remark ? String(body.remark) : ''
  const rawItems = Array.isArray(body.items) ? body.items : []

  if (!supplier) {
    return res.status(400).json({ error: '供应商不能为空' })
  }
  if (rawItems.length === 0) {
    return res.status(400).json({ error: '至少需要一行明细' })
  }

  const items = normalizeItems(rawItems)
  // 字段级校验：入库不校验 cubic > 0
  const problems = validateItems(items)
  if (problems.length > 0) {
    return res.status(400).json({ error: problems.join('\n') })
  }

  try {
    const result = createInbound({
      orderNo: buildOrderNo(orderDate),
      supplier,
      orderDate,
      remark,
      items,
    })
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 入库单列表（可选筛选：供应商关键字、日期范围）
router.get('/', (req, res) => {
  const { supplier, date_from: dateFrom, date_to: dateTo } = req.query
  const conditions = []
  const params = []

  if (supplier && String(supplier).trim()) {
    conditions.push(`o.supplier LIKE ?`)
    params.push(`%${String(supplier).trim()}%`)
  }
  if (dateFrom) {
    conditions.push(`o.order_date >= ?`)
    params.push(String(dateFrom))
  }
  if (dateTo) {
    conditions.push(`o.order_date <= ?`)
    params.push(String(dateTo))
  }

  const rows = db
    .prepare(
      `SELECT o.id,
              o.order_no,
              o.supplier,
              o.order_date,
              ROUND(COALESCE(SUM(i.cubic), 0), 4)  AS total_cubic,
              ROUND(COALESCE(SUM(i.amount), 0), 2) AS total_amount,
              COUNT(i.id)                          AS item_count
         FROM inbound_orders o
         LEFT JOIN order_items i
                ON i.order_id = o.id AND i.order_type = 'in'
        ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
        GROUP BY o.id
        ORDER BY o.id DESC`,
    )
    .all(...params)

  res.json(rows)
})

// 入库单详情：单头 + 全部明细
router.get('/:id', (req, res) => {
  const id = Number(req.params.id)
  const order = db
    .prepare(`SELECT * FROM inbound_orders WHERE id = ?`)
    .get(id)

  if (!order) {
    return res.status(404).json({ error: '入库单不存在' })
  }

  const items = db
    .prepare(
      `SELECT * FROM order_items
        WHERE order_type = 'in' AND order_id = ?
        ORDER BY id`,
    )
    .all(id)

  const totals = items.reduce(
    (acc, item) => ({
      total_cubic: Number((acc.total_cubic + (item.cubic ?? 0)).toFixed(4)),
      total_amount: Number((acc.total_amount + (item.amount ?? 0)).toFixed(2)),
    }),
    { total_cubic: 0, total_amount: 0 },
  )

  res.json({ ...order, ...totals, items })
})

/* ---------- 删除 ---------- */

const getOrderStmt = db.prepare(
  `SELECT id, order_no FROM inbound_orders WHERE id = ?`,
)

const orderItemsStmt = db.prepare(
  `SELECT species, grade, thickness, width, length, cubic, bundles
     FROM order_items
    WHERE order_type = 'in' AND order_id = ?`,
)

// 某规格当前库存：入库合计 - 出库合计
const stockOfSpecStmt = db.prepare(
  `SELECT COALESCE(SUM(CASE WHEN order_type = 'in' THEN cubic   ELSE -cubic   END), 0) AS cubic,
          COALESCE(SUM(CASE WHEN order_type = 'in' THEN bundles ELSE -bundles END), 0) AS bundles
     FROM order_items
    WHERE species = ?
      AND COALESCE(grade, '') = ?
      AND thickness = ?
      AND width = ?
      AND length = ?`,
)

const deleteOrderItemsStmt = db.prepare(
  `DELETE FROM order_items WHERE order_type = 'in' AND order_id = ?`,
)
const deleteOrderStmt = db.prepare(`DELETE FROM inbound_orders WHERE id = ?`)

// 事务：先校验删完库存会不会变负，通过后再删明细、删单头
const removeInbound = db.transaction((id) => {
  const order = getOrderStmt.get(id)
  if (!order) {
    const error = new Error('入库单不存在')
    error.status = 404
    throw error
  }

  // 同规格的多行先合并
  const groups = new Map()
  for (const item of orderItemsStmt.all(id)) {
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
    const currentCubic = Number((stock?.cubic ?? 0).toFixed(4))
    const currentBundles = stock?.bundles ?? 0
    const afterCubic = Number((currentCubic - group.cubic).toFixed(4))
    const afterBundles = currentBundles - group.bundles

    if (afterCubic < 0 || afterBundles < 0) {
      problems.push(
        `无法删除：${group.species}（等级 ${group.grade || '—'}）` +
          `厚${group.thickness}×宽${group.width}×长${group.length}，` +
          `当前库存 ${currentCubic} 立方 / ${currentBundles} 件，` +
          `删除后会变成 ${afterCubic} 立方 / ${afterBundles} 件，库存不能为负`,
      )
    }
  }

  if (problems.length > 0) {
    const error = new Error(problems.join('\n'))
    error.status = 400
    throw error
  }

  deleteOrderItemsStmt.run(id)
  deleteOrderStmt.run(id)

  return order
})

// 删除入库单
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '入库单 ID 不合法' })
  }

  try {
    removeInbound(id)
    res.json({ ok: true })
  } catch (err) {
    if (err.status === 400 || err.status === 404) {
      return res.status(err.status).json({ error: err.message })
    }
    res.status(500).json({ error: err.message })
  }
})

export default router
