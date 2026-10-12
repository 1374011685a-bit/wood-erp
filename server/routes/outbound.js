import express from 'express'
import { db } from '../db.js'
import { calcCubic, calcAmount } from '../utils/cubic.js'
import { validateItems } from '../utils/validateItems.js'

const router = express.Router()

const roundTo = (value, digits) => Number(value.toFixed(digits))

/** 本地日期 YYYY-MM-DD */
function todayLocal() {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** 单号规则：CK + YYYYMMDD + 当天 4 位流水 */
function buildOrderNo(orderDate) {
  const date = orderDate || todayLocal()
  const prefix = `CK${date.replace(/-/g, '')}`
  const last = db
    .prepare(
      `SELECT order_no FROM outbound_orders
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

/** 规格：品名 + 等级 + 厚度 + 宽度 + 长度 */
function specOf(item) {
  return {
    species: String(item.species ?? '').trim(),
    grade: String(item.grade ?? '').trim(),
    thickness: toNumber(item.thickness),
    width: toNumber(item.width),
    length: toNumber(item.length),
  }
}

function specKey(spec) {
  return [spec.species, spec.grade, spec.thickness, spec.width, spec.length].join('|')
}

// 当前库存：入库合计 - 出库合计（按规格归组）
const stockStmt = db.prepare(
  `SELECT COALESCE(SUM(CASE WHEN order_type = 'in'  THEN cubic   ELSE -cubic   END), 0) AS cubic,
          COALESCE(SUM(CASE WHEN order_type = 'in'  THEN bundles ELSE -bundles END), 0) AS bundles
     FROM order_items
    WHERE species = ?
      AND COALESCE(grade, '') = ?
      AND thickness = ?
      AND width = ?
      AND length = ?`,
)

// 该规格最近一次入库的「每件片数」，用于出库表单自动带出
const inboundPiecesStmt = db.prepare(
  `SELECT pieces FROM order_items
    WHERE order_type = 'in'
      AND species = ?
      AND COALESCE(grade, '') = ?
      AND thickness = ?
      AND width = ?
      AND length = ?
    ORDER BY id DESC
    LIMIT 1`,
)

// 该规格是否存在入库记录（区分「从没入库过」和「入库过但已出完」）
const inboundExistsStmt = db.prepare(
  `SELECT 1 AS ok FROM order_items
    WHERE order_type = 'in'
      AND species = ?
      AND COALESCE(grade, '') = ?
      AND thickness = ?
      AND width = ?
      AND length = ?
    LIMIT 1`,
)

function getStock(spec) {
  const row = stockStmt.get(
    spec.species,
    spec.grade,
    spec.thickness,
    spec.width,
    spec.length,
  )
  return {
    cubic: roundTo(row?.cubic ?? 0, 4),
    bundles: row?.bundles ?? 0,
    pieces:
      inboundPiecesStmt.get(
        spec.species,
        spec.grade,
        spec.thickness,
        spec.width,
        spec.length,
      )?.pieces ?? 0,
  }
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
    const spec = specOf(item)
    const pieces = optionalNumber(item.pieces, 1)
    const bundles = optionalNumber(item.bundles, 1)
    const unitPrice = toNumber(item.unit_price)
    const cubic = calcCubic(
      spec.thickness,
      spec.width,
      spec.length,
      pieces,
      bundles,
    )

    return {
      ...spec,
      pieces,
      bundles,
      cubic,
      unit_price: unitPrice,
      amount: calcAmount(cubic, unitPrice),
    }
  })
}

/**
 * 库存校验：同一规格的多行先合并，再与当前库存比对
 * 错误信息区分三种情况：规格不存在 / 库存为 0 / 库存不够
 * @returns {string[]} 库存不足的提示信息
 */
function specText(group) {
  return (
    `品名=${group.species}，等级=${group.grade || '（空）'}，` +
    `厚=${group.thickness}，宽=${group.width}，长=${group.length}`
  )
}

function checkStock(items) {
  const groups = new Map()

  for (const item of items) {
    const key = specKey(item)
    const group = groups.get(key) ?? {
      species: item.species,
      grade: item.grade,
      thickness: item.thickness,
      width: item.width,
      length: item.length,
      cubic: 0,
      bundles: 0,
    }
    group.cubic += item.cubic
    group.bundles += item.bundles
    groups.set(key, group)
  }

  const problems = []

  for (const group of groups.values()) {
    const needed = roundTo(group.cubic, 4)
    const stock = getStock(group)

    if (needed <= stock.cubic + 1e-9) continue

    const everInbound = Boolean(
      inboundExistsStmt.get(
        group.species,
        group.grade,
        group.thickness,
        group.width,
        group.length,
      ),
    )

    if (stock.cubic <= 0) {
      if (!everInbound) {
        problems.push(
          `该规格当前无库存：${specText(group)}。` +
            `请检查是否与入库时填写的规格完全一致（品名、等级、尺寸任一项不同都算不同规格）。` +
            `系统中不存在此规格的入库记录，请先入库或从库存列表中选择。`,
        )
      } else {
        problems.push(
          `该规格当前库存为 0（曾入库过，已全部出库）：${specText(group)}。` +
            `本次出库 ${needed} 立方 / ${group.bundles} 件。`,
        )
      }
    } else {
      problems.push(
        `库存不足：${specText(group)}，` +
          `当前库存 ${stock.cubic} 立方 / ${stock.bundles} 件，` +
          `本次出库 ${needed} 立方 / ${group.bundles} 件。`,
      )
    }
  }

  return problems
}

const insertOrder = db.prepare(
  `INSERT INTO outbound_orders (order_no, customer, order_date, remark)
   VALUES (?, ?, ?, ?)`,
)

const insertItem = db.prepare(
  `INSERT INTO order_items
     (order_id, order_type, species, grade, thickness, width, length,
      pieces, bundles, cubic, unit_price, amount)
   VALUES
     (@order_id, 'out', @species, @grade, @thickness, @width, @length,
      @pieces, @bundles, @cubic, @unit_price, @amount)`,
)

// 事务：库存校验与写入放在同一事务里，避免并发超卖
const createOutbound = db.transaction(
  ({ orderNo, customer, orderDate, remark, items }) => {
    const problems = checkStock(items)
    if (problems.length > 0) {
      const error = new Error(problems.join('\n'))
      error.status = 400
      throw error
    }

    const { lastInsertRowid } = insertOrder.run(
      orderNo,
      customer,
      orderDate,
      remark || null,
    )
    const orderId = Number(lastInsertRowid)
    for (const item of items) {
      insertItem.run({ ...item, order_id: orderId })
    }
    return { id: orderId, order_no: orderNo }
  },
)

// 新增出库单
router.post('/', (req, res) => {
  const body = req.body ?? {}
  const customer = String(body.customer ?? '').trim()
  const orderDate = body.order_date ? String(body.order_date) : todayLocal()
  const remark = body.remark ? String(body.remark) : ''
  const rawItems = Array.isArray(body.items) ? body.items : []

  if (!customer) {
    return res.status(400).json({ error: '客户不能为空' })
  }
  if (rawItems.length === 0) {
    return res.status(400).json({ error: '至少需要一行明细' })
  }

  const items = normalizeItems(rawItems)
  // 字段级校验：出库额外要求该行立方大于 0（库存校验在事务里，逻辑未改动）
  const problems = validateItems(items, { requirePositiveCubic: true })
  if (problems.length > 0) {
    return res.status(400).json({ error: problems.join('\n') })
  }

  try {
    const result = createOutbound({
      orderNo: buildOrderNo(orderDate),
      customer,
      orderDate,
      remark,
      items,
    })
    res.json(result)
  } catch (err) {
    if (err.status === 400) {
      return res.status(400).json({ error: err.message })
    }
    res.status(500).json({ error: err.message })
  }
})

// 某个规格的当前库存（供出库表单实时提示）
router.get('/stock', (req, res) => {
  const spec = specOf(req.query)

  if (!spec.species || spec.thickness <= 0 || spec.width <= 0 || spec.length <= 0) {
    return res.status(400).json({ error: '规格参数不完整' })
  }

  res.json(getStock(spec))
})

// 出库单列表（可选筛选：客户关键字、日期范围）
router.get('/', (req, res) => {
  const { customer, date_from: dateFrom, date_to: dateTo } = req.query
  const conditions = []
  const params = []

  if (customer && String(customer).trim()) {
    conditions.push(`o.customer LIKE ?`)
    params.push(`%${String(customer).trim()}%`)
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
              o.customer,
              o.order_date,
              ROUND(COALESCE(SUM(i.cubic), 0), 4)  AS total_cubic,
              ROUND(COALESCE(SUM(i.amount), 0), 2) AS total_amount,
              COUNT(i.id)                          AS item_count
         FROM outbound_orders o
         LEFT JOIN order_items i
                ON i.order_id = o.id AND i.order_type = 'out'
        ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
        GROUP BY o.id
        ORDER BY o.id DESC`,
    )
    .all(...params)

  res.json(rows)
})

// 出库单详情：单头 + 全部明细
router.get('/:id', (req, res) => {
  const id = Number(req.params.id)
  const order = db
    .prepare(`SELECT * FROM outbound_orders WHERE id = ?`)
    .get(id)

  if (!order) {
    return res.status(404).json({ error: '出库单不存在' })
  }

  const items = db
    .prepare(
      `SELECT * FROM order_items
        WHERE order_type = 'out' AND order_id = ?
        ORDER BY id`,
    )
    .all(id)

  const totals = items.reduce(
    (acc, item) => ({
      total_cubic: roundTo(acc.total_cubic + (item.cubic ?? 0), 4),
      total_amount: roundTo(acc.total_amount + (item.amount ?? 0), 2),
    }),
    { total_cubic: 0, total_amount: 0 },
  )

  res.json({ ...order, ...totals, items })
})

/* ---------- 删除 ---------- */

const getOrderStmt = db.prepare(
  `SELECT id, order_no FROM outbound_orders WHERE id = ?`,
)
const deleteOrderItemsStmt = db.prepare(
  `DELETE FROM order_items WHERE order_type = 'out' AND order_id = ?`,
)
const deleteOrderStmt = db.prepare(`DELETE FROM outbound_orders WHERE id = ?`)

// 事务：出库单删除后库存只会回涨，不需要额外校验
const removeOutbound = db.transaction((id) => {
  const order = getOrderStmt.get(id)
  if (!order) {
    const error = new Error('出库单不存在')
    error.status = 404
    throw error
  }

  deleteOrderItemsStmt.run(id)
  deleteOrderStmt.run(id)

  return order
})

// 删除出库单
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '出库单 ID 不合法' })
  }

  try {
    removeOutbound(id)
    res.json({ ok: true })
  } catch (err) {
    if (err.status === 400 || err.status === 404) {
      return res.status(err.status).json({ error: err.message })
    }
    res.status(500).json({ error: err.message })
  }
})

export default router
