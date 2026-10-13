import express from 'express'
import { db } from '../db.js'
import { calcCubic, calcAmountCents, toCents, fromCents } from '../utils/cubic.js'
import { validateItems } from '../utils/validateItems.js'
import { pageParams } from '../utils/paging.js'

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
    WHERE deleted_at IS NULL
      AND species = ?
      AND COALESCE(grade, '') = ?
      AND thickness = ?
      AND width = ?
      AND length = ?`,
)

// 该规格最近一次入库的「每件片数」，用于出库表单自动带出
const inboundPiecesStmt = db.prepare(
  `SELECT pieces FROM order_items
    WHERE order_type = 'in'
      AND deleted_at IS NULL
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
      AND deleted_at IS NULL
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
    const cubic = calcCubic(
      spec.thickness,
      spec.width,
      spec.length,
      pieces,
      bundles,
    )
    // 金额一律走整数分，避免浮点累加误差；unit_price / amount 只是显示镜像
    const unitPriceCents = toCents(item.unit_price)
    const amountCents = calcAmountCents(cubic, unitPriceCents)

    return {
      ...spec,
      pieces,
      bundles,
      cubic,
      unit_price: fromCents(unitPriceCents),
      amount: fromCents(amountCents),
      unit_price_cents: unitPriceCents,
      amount_cents: amountCents,
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

/**
 * 码单校验：出库是按包发的，每一包都必须是「在库」状态。
 * 重复、已出、传错的码单都在这里挡下来，并说清楚是哪一包。
 */
function checkBales(baleIds) {
  const problems = []
  const seen = new Set()
  const findBale = db.prepare(`SELECT bale_no, status FROM bales WHERE id = ?`)

  for (const id of baleIds) {
    if (!Number.isInteger(id) || id <= 0) {
      problems.push('码单编号不合法')
      continue
    }
    if (seen.has(id)) {
      problems.push(`码单重复选择（id ${id}）`)
      continue
    }
    seen.add(id)

    const bale = findBale.get(id)
    if (!bale) {
      problems.push(`码单不存在（id ${id}）`)
      continue
    }
    if (bale.status !== 'in_stock') {
      problems.push(`码单 ${bale.bale_no} 已经出库了，不能重复发货`)
    }
  }

  return problems
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
  `INSERT INTO outbound_orders
     (order_no, customer, order_date, remark, warehouse, operator, vehicle_no)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
)

const insertItem = db.prepare(
  `INSERT INTO order_items
     (order_id, order_type, species, grade, thickness, width, length,
      pieces, bundles, cubic, unit_price, amount, unit_price_cents, amount_cents)
   VALUES
     (@order_id, 'out', @species, @grade, @thickness, @width, @length,
      @pieces, @bundles, @cubic, @unit_price, @amount, @unit_price_cents, @amount_cents)`,
)

// 事务：库存校验与写入放在同一事务里，避免并发超卖
const createOutbound = db.transaction(
  ({
    orderNo,
    customer,
    orderDate,
    remark,
    warehouse,
    operator,
    vehicleNo,
    items,
    baleIds,
  }) => {
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
      warehouse,
      operator || null,
      vehicleNo || null,
    )
    const orderId = Number(lastInsertRowid)
    items.forEach((item, index) => {
      insertItem.run({ ...item, order_id: orderId })
    })

    // 把这次发走的码单标记成已出库，并挂到出库单上
    const markShipped = db.prepare(
      `UPDATE bales
          SET status = 'shipped',
              outbound_order_id = ?,
              shipped_at = datetime('now', 'localtime')
        WHERE id = ? AND status = 'in_stock'`,
    )
    for (const baleId of baleIds) {
      markShipped.run(orderId, baleId)
    }

    return { id: orderId, order_no: orderNo, bale_count: baleIds.length }
  },
)

// 新增出库单
router.post('/', (req, res) => {
  const body = req.body ?? {}
  const customer = String(body.customer ?? '').trim()
  const orderDate = body.order_date ? String(body.order_date) : todayLocal()
  const remark = body.remark ? String(body.remark) : ''
  const warehouse = String(body.warehouse ?? '').trim()
  const operator = String(body.operator ?? '').trim()
  const rawItems = Array.isArray(body.items) ? body.items : []
  const rawBales = Array.isArray(body.bale_ids) ? body.bale_ids.map(Number) : []
  const vehicleNo = String(body.vehicle_no ?? '').trim()

  if (!customer) {
    return res.status(400).json({ error: '客户不能为空' })
  }
  if (!warehouse) {
    return res.status(400).json({ error: '仓库不能为空' })
  }
  if (rawItems.length === 0) {
    return res.status(400).json({ error: '至少需要一行明细' })
  }

  // 码单校验：必须都是「在库」状态，别人发过的包不能再发一次
  const baleErrors = checkBales(rawBales)
  if (baleErrors.length > 0) {
    return res.status(400).json({ error: baleErrors.join('\n') })
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
      warehouse,
      operator,
      vehicleNo,
      items,
      baleIds: rawBales,
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

/* ---------- 修改 ---------- */

const updateOrderStmt = db.prepare(
  `UPDATE outbound_orders
      SET customer = ?, order_date = ?, remark = ?, warehouse = ?, operator = ?,
          vehicle_no = ?
    WHERE id = ? AND deleted_at IS NULL`,
)
const replaceOrderItemsStmt = db.prepare(
  `DELETE FROM order_items WHERE order_type = 'out' AND order_id = ?`,
)

/** 把一条明细按符号累加到「规格 → 净变化」表里 */
function bumpGroups(groups, item, sign) {
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
  group.cubic += sign * (item.cubic ?? 0)
  group.bundles += sign * (item.bundles ?? 0)
  groups.set(key, group)
}

/**
 * 事务：先删旧明细再插新明细。
 *
 * 出库的方向和入库相反：删掉旧明细把货还回来（+cubic），新明细再扣一次（−cubic）。
 * 净影响加在当前库存上，任何规格改完为负就整单回滚——等于把「出库不能超卖」
 * 这条规则套用到修改上。单号保持不变。
 */
const updateOutbound = db.transaction(
  ({ id, customer, orderDate, remark, warehouse, operator, vehicleNo, items }) => {
  const order = getOrderStmt.get(id)
  if (!order) {
    const error = new Error('出库单不存在')
    error.status = 404
    throw error
  }

  const deltas = new Map()
  for (const item of orderItemsStmt.all(id)) bumpGroups(deltas, item, 1)
  for (const item of items) bumpGroups(deltas, item, -1)

  const problems = []
  for (const group of deltas.values()) {
    if (group.cubic === 0 && group.bundles === 0) continue

    const stock = stockStmt.get(
      group.species,
      group.grade,
      group.thickness,
      group.width,
      group.length,
    )
    const currentCubic = Number((stock?.cubic ?? 0).toFixed(4))
    const currentBundles = stock?.bundles ?? 0
    const afterCubic = Number((currentCubic + group.cubic).toFixed(4))
    const afterBundles = currentBundles + group.bundles

    if (afterCubic < 0 || afterBundles < 0) {
      problems.push(
        `无法修改：${group.species}（等级 ${group.grade || '—'}）` +
          `厚${group.thickness}×宽${group.width}×长${group.length}，` +
          `当前库存 ${currentCubic} 立方 / ${currentBundles} 件，` +
          `改完会变成 ${afterCubic} 立方 / ${afterBundles} 件，库存不能为负`,
      )
    }
  }

  if (problems.length > 0) {
    const error = new Error(problems.join('\n'))
    error.status = 400
    throw error
  }

  replaceOrderItemsStmt.run(id)
  for (const item of items) {
    insertItem.run({ ...item, order_id: id })
  }
  updateOrderStmt.run(
    customer,
    orderDate,
    remark || null,
    warehouse,
    operator || null,
    vehicleNo || null,
    id,
  )

  return { id, order_no: order.order_no }
  },
)

// 修改出库单（明细整体替换，单号不变）
router.put('/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '出库单 ID 不合法' })
  }

  const body = req.body ?? {}
  const customer = String(body.customer ?? '').trim()
  const orderDate = body.order_date ? String(body.order_date) : todayLocal()
  const remark = body.remark ? String(body.remark) : ''
  const warehouse = String(body.warehouse ?? '').trim()
  const operator = String(body.operator ?? '').trim()
  const rawItems = Array.isArray(body.items) ? body.items : []

  if (!customer) {
    return res.status(400).json({ error: '客户不能为空' })
  }
  if (!warehouse) {
    return res.status(400).json({ error: '仓库不能为空' })
  }
  if (rawItems.length === 0) {
    return res.status(400).json({ error: '至少需要一行明细' })
  }

  const items = normalizeItems(rawItems)
  const problems = validateItems(items, { requirePositiveCubic: true })
  if (problems.length > 0) {
    return res.status(400).json({ error: problems.join('\n') })
  }

  try {
    res.json(
      updateOutbound({
        id,
        customer,
        orderDate,
        remark,
        warehouse,
        operator,
        vehicleNo: String(body.vehicle_no ?? '').trim(),
        items,
      }),
    )
  } catch (err) {
    if (err.status === 400 || err.status === 404) {
      return res.status(err.status).json({ error: err.message })
    }
    res.status(500).json({ error: err.message })
  }
})

/**
 * 出库单列表
 * 筛选：单号 / 客户 / 仓库 / 操作员 / 日期范围；分页 limit + offset，返回 total
 */
router.get('/', (req, res) => {
  const {
    order_no: orderNo,
    customer,
    warehouse,
    operator,
    date_from: dateFrom,
    date_to: dateTo,
  } = req.query

  // 软删除的单据不参与列表
  const conditions = [`o.deleted_at IS NULL`]
  const params = []

  const like = (value) => {
    const text = String(value ?? '').trim()
    return text ? `%${text}%` : ''
  }

  const orderNoLike = like(orderNo)
  if (orderNoLike) {
    conditions.push(`o.order_no LIKE ?`)
    params.push(orderNoLike)
  }

  const customerLike = like(customer)
  if (customerLike) {
    conditions.push(`o.customer LIKE ?`)
    params.push(customerLike)
  }

  const warehouseLike = like(warehouse)
  if (warehouseLike) {
    conditions.push(`o.warehouse LIKE ?`)
    params.push(warehouseLike)
  }

  const operatorLike = like(operator)
  if (operatorLike) {
    conditions.push(`o.operator LIKE ?`)
    params.push(operatorLike)
  }

  if (dateFrom) {
    conditions.push(`o.order_date >= ?`)
    params.push(String(dateFrom))
  }
  if (dateTo) {
    conditions.push(`o.order_date <= ?`)
    params.push(String(dateTo))
  }

  const where = `WHERE ${conditions.join(' AND ')}`
  const total = Number(
    db.prepare(`SELECT COUNT(*) AS total FROM outbound_orders o ${where}`).get(...params)
      ?.total ?? 0,
  )
  const { limit, offset } = pageParams(req.query)

  const rows = db
    .prepare(
      `SELECT o.id,
              o.order_no,
              o.customer,
              o.order_date,
              o.warehouse,
              o.operator,
              ROUND(COALESCE(SUM(i.cubic), 0), 4)  AS total_cubic,
              ROUND(COALESCE(SUM(COALESCE(i.amount_cents, ROUND(i.amount * 100))), 0) / 100.0, 2)
                                                   AS total_amount,
              COUNT(i.id)                          AS item_count
         FROM outbound_orders o
         LEFT JOIN order_items i
                ON i.order_id = o.id AND i.order_type = 'out'
        ${where}
        GROUP BY o.id
        ORDER BY o.id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset)

  res.json({ total, limit, offset, rows })
})

// 出库单详情：单头 + 全部明细
router.get('/:id', (req, res) => {
  const id = Number(req.params.id)
  const order = db
    .prepare(`SELECT * FROM outbound_orders WHERE id = ? AND deleted_at IS NULL`)
    .get(id)

  if (!order) {
    return res.status(404).json({ error: '出库单不存在' })
  }

  const items = db
    .prepare(
      `SELECT * FROM order_items
        WHERE order_type = 'out' AND order_id = ? AND deleted_at IS NULL
        ORDER BY id`,
    )
    .all(id)

  // 金额按整数分累加，最后一次性换算成元
  const totals = items.reduce(
    (acc, item) => ({
      total_cubic: roundTo(acc.total_cubic + (item.cubic ?? 0), 4),
      amountCents:
        acc.amountCents +
        Number(item.amount_cents ?? Math.round((item.amount ?? 0) * 100)),
    }),
    { total_cubic: 0, amountCents: 0 },
  )

  /**
   * 每行带上「该规格当前还剩多少库存」——出库后要能一眼看出还剩多少，
   * 方便判断还能不能再发下一车。
   */
  const itemsWithStock = items.map((item) => {
    const stock = stockStmt.get(
      item.species,
      item.grade ?? '',
      item.thickness,
      item.width,
      item.length,
    )
    return {
      ...item,
      stock_cubic: roundTo(stock?.cubic ?? 0, 4),
      stock_bundles: stock?.bundles ?? 0,
    }
  })

  // 这张单发走的码单（一包一条），能看出是哪几包、属于哪个柜和合同
  const bales = db
    .prepare(
      `SELECT b.bale_no, b.barcode, b.cubic, b.pieces, b.status,
              c.container_no, c.contract_no
         FROM bales b
         LEFT JOIN containers c ON c.id = b.container_id
        WHERE b.outbound_order_id = ?
        ORDER BY b.bale_no`,
    )
    .all(id)
    .map((row) => ({
      bale_no: row.bale_no,
      barcode: row.barcode ?? row.bale_no ?? '',
      cubic: roundTo(row.cubic ?? 0, 4),
      pieces: row.pieces ?? 0,
      status: row.status,
      container_no: row.container_no ?? '',
      contract_no: row.contract_no ?? '',
    }))

  res.json({
    ...order,
    total_cubic: totals.total_cubic,
    total_amount: fromCents(totals.amountCents),
    items: itemsWithStock,
    bales,
  })
})

/* ---------- 删除 ---------- */

const getOrderStmt = db.prepare(
  `SELECT id, order_no FROM outbound_orders WHERE id = ? AND deleted_at IS NULL`,
)

// 修改时的差异校验要按规格比对，所以这里也要能取到未删除的明细
const orderItemsStmt = db.prepare(
  `SELECT species, grade, thickness, width, length, cubic, bundles
     FROM order_items
    WHERE order_type = 'out' AND order_id = ? AND deleted_at IS NULL`,
)

// 软删除：只打时间戳，明细一起标记，回收站里可以整单恢复
const softDeleteOrderItemsStmt = db.prepare(
  `UPDATE order_items
      SET deleted_at = datetime('now', 'localtime')
    WHERE order_type = 'out' AND order_id = ? AND deleted_at IS NULL`,
)
const softDeleteOrderStmt = db.prepare(
  `UPDATE outbound_orders
      SET deleted_at = datetime('now', 'localtime')
    WHERE id = ? AND deleted_at IS NULL`,
)

// 撤销出库：发走的码单要退回在库，货才算回到库里
const releaseBalesStmt = db.prepare(
  `UPDATE bales
      SET status = 'in_stock', outbound_order_id = NULL, shipped_at = NULL
    WHERE outbound_order_id = ?`,
)

// 事务：出库单删除后库存只会回涨，不需要额外校验
const removeOutbound = db.transaction((id) => {
  const order = getOrderStmt.get(id)
  if (!order) {
    const error = new Error('出库单不存在')
    error.status = 404
    throw error
  }

  softDeleteOrderItemsStmt.run(id)
  softDeleteOrderStmt.run(id)
  // 码单退回在库
  releaseBalesStmt.run(id)

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
