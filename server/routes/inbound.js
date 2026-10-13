import express from 'express'
import { db } from '../db.js'
import { calcCubic, calcAmountCents, toCents, fromCents } from '../utils/cubic.js'
import { validateItems } from '../utils/validateItems.js'
import { pageParams } from '../utils/paging.js'
import { createBalesForItem, preflightBales } from './bales.js'

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
    const cubic = calcCubic(thickness, width, length, pieces, bundles)
    // 金额一律走整数分，避免浮点累加误差；unit_price / amount 只是显示镜像
    const unitPriceCents = toCents(item.unit_price)
    const amountCents = calcAmountCents(cubic, unitPriceCents)

    return {
      brand: String(item.brand ?? '').trim(),
      species: String(item.species ?? '').trim(),
      grade: String(item.grade ?? '').trim(),
      thickness,
      width,
      length,
      pieces,
      bundles,
      cubic,
      unit_price: fromCents(unitPriceCents),
      amount: fromCents(amountCents),
      unit_price_cents: unitPriceCents,
      amount_cents: amountCents,
      // 包号（可空）：填了就按这些包号生成码单，没填按包数自动编号
      bale_labels: Array.isArray(item.bale_labels)
        ? item.bale_labels.map((label) => String(label).trim()).filter(Boolean)
        : [],
      // 柜号：这一行货装在哪个柜/柜里
      box_no: String(item.box_no ?? '').trim(),
      // 「同包再加一行」：明确标记过的行，才允许往已有的包里追加规格
      same_package: item.same_package === true,
      // 这行的包号（人填的原文，编辑时原样读回）
      bale_no: Array.isArray(item.bale_labels) && item.bale_labels.length > 0
        ? item.bale_labels.join('、')
        : String(item.bale_no ?? '').trim(),
    }
  })
}

const insertOrder = db.prepare(
  `INSERT INTO inbound_orders
     (order_no, supplier, order_date, remark, warehouse, operator,
      bl_no, contract_no, vehicle_no, shipment_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
)

const findShipmentStmt = db.prepare(
  `SELECT * FROM shipments WHERE id = ? AND deleted_at IS NULL`,
)
const findShipmentByNoStmt = db.prepare(
  `SELECT * FROM shipments WHERE lower(bl_no) = lower(?) AND deleted_at IS NULL`,
)
const insertShipmentStmt = db.prepare(
  `INSERT INTO shipments (bl_no, contract_no, supplier, arrival_date, remark)
   VALUES (?, ?, ?, ?, ?)`,
)

/**
 * 把「这次请求里刚建的提单」撤掉。
 *
 * 为什么需要：手打新提单号时我们会顺手建一张提单，然后才做明细预检。
 * 预检/写库失败时如果不撤，库里就留下一张 0 包的空提单（还能在提单下拉里选到）。
 * 只有确认这张提单下面一包货都没有，才真删。
 */
function dropEmptyShipment(shipmentId) {
  if (!shipmentId) return
  const bales =
    db
      .prepare(
        `SELECT COUNT(*) AS total FROM bales
          WHERE shipment_id = ? AND deleted_at IS NULL`,
      )
      .get(shipmentId)?.total ?? 0
  if (bales > 0) return
  db.prepare(`DELETE FROM shipments WHERE id = ?`).run(shipmentId)
}

const insertItem = db.prepare(
  `INSERT INTO order_items
     (order_id, order_type, box_no, bale_no, brand, species, grade, thickness, width, length,
      pieces, bundles, cubic, unit_price, amount, unit_price_cents, amount_cents)
   VALUES
     (@order_id, 'in', @box_no, @bale_no, @brand, @species, @grade, @thickness, @width, @length,
      @pieces, @bundles, @cubic, @unit_price, @amount, @unit_price_cents, @amount_cents)`,
)

// 事务：先插单头，再批量插明细
const createInbound = db.transaction(
  ({
    orderNo,
    supplier,
    orderDate,
    remark,
    warehouse,
    operator,
    blNo,
    contractNo,
    vehicleNo,
    shipmentId,
    shipmentNo,
    items,
  }) => {
  const { lastInsertRowid } = insertOrder.run(
    orderNo,
    supplier,
    orderDate,
    remark || null,
    warehouse,
    operator || null,
    blNo || null,
    contractNo || null,
    vehicleNo || null,
    shipmentId ?? null,
  )
  const orderId = Number(lastInsertRowid)
  const barcodes = []
  for (const item of items) {
    insertItem.run({ ...item, order_id: orderId })
    // 每一包生成一个码单（贴包上的那张）
    barcodes.push(
      ...createBalesForItem({
        item,
        shipmentId,
        shipmentNo,
        inboundOrderId: orderId,
        inboundOrderNo: orderNo,
        baleLabels: item.bale_labels,
        samePackage: item.same_package,
      }),
    )
  }
  return {
    id: orderId,
    order_no: orderNo,
    bale_count: barcodes.length,
    barcodes,
  }
  },
)

// 新增入库单
router.post('/', (req, res) => {
  const body = req.body ?? {}
  const supplier = String(body.supplier ?? '').trim()
  const orderDate = body.order_date ? String(body.order_date) : todayLocal()
  const remark = body.remark ? String(body.remark) : ''
  const warehouse = String(body.warehouse ?? '').trim()
  const operator = String(body.operator ?? '').trim()
  const blNo = String(body.bl_no ?? '').trim()
  const contractNo = String(body.contract_no ?? '').trim()
  const vehicleNo = String(body.vehicle_no ?? '').trim()
  // 可以选一张提单（整票到货），合同号 / 提单号从提单上带出来
  const shipmentId = Number(body.shipment_id) || null
  const rawItems = Array.isArray(body.items) ? body.items : []

  if (!supplier) {
    return res.status(400).json({ error: '供应商不能为空' })
  }
  if (!warehouse) {
    return res.status(400).json({ error: '仓库不能为空' })
  }
  // 一票货一个提单号：留空就不收（前端也会先拦一次）
  if (!blNo) {
    return res.status(400).json({ error: '提单号必填，一票货一个号' })
  }

  // ── 先做不依赖提单的校验：能便宜地挡掉的就别先去建提单 ──
  if (rawItems.length === 0) {
    return res.status(400).json({ error: '至少需要一行明细' })
  }

  const items = normalizeItems(rawItems)
  // 字段级校验：入库不校验 cubic > 0
  const problems = validateItems(items)
  if (problems.length > 0) {
    return res.status(400).json({ error: problems.join('\n') })
  }

  // ── 再解析 / 建档提单 ──
  let shipment = null
  // 记下「这次请求里新建的提单」：万一后面校验失败，要把它删掉，不留 0 包空提单
  let createdShipmentId = null
  if (shipmentId) {
    shipment = findShipmentStmt.get(shipmentId)
    if (!shipment) {
      return res.status(400).json({ error: '选中的提单不存在' })
    }
  }
  // 手打了提单号（直接入库那种）：找到这张提单就挂上去，没有就顺手建一张，
  // 这样「采购入库明细」里一定看得到这票货，不会断链。
  if (!shipment && blNo) {
    shipment = findShipmentByNoStmt.get(blNo) ?? null
    if (!shipment) {
      const { lastInsertRowid } = insertShipmentStmt.run(
        blNo,
        contractNo || null,
        supplier || null,
        orderDate,
        '入库时自动建档',
      )
      createdShipmentId = Number(lastInsertRowid)
      shipment = {
        id: createdShipmentId,
        bl_no: blNo,
        contract_no: contractNo || null,
      }
    }
  }

  // 包号 / 件数 / 查重：全部在写库之前拦下，保证要么全写成、要么一条不写
  try {
    preflightBales({
      shipmentId: shipment ? shipment.id : null,
      inboundOrderId: null,
      items,
    })
  } catch (err) {
    dropEmptyShipment(createdShipmentId)
    return res.status(err.status === 400 ? 400 : 500).json({ error: err.message })
  }

  try {
    const result = createInbound({
      orderNo: buildOrderNo(orderDate),
      supplier,
      orderDate,
      remark,
      warehouse,
      operator,
      blNo: shipment ? shipment.bl_no : blNo,
      contractNo: shipment ? shipment.contract_no : contractNo,
      vehicleNo,
      shipmentId: shipment ? shipment.id : null,
      shipmentNo: shipment ? shipment.bl_no : null,
      items,
    })
    res.json(result)
  } catch (err) {
    dropEmptyShipment(createdShipmentId)
    res.status(500).json({ error: err.message })
  }
})

/* ---------- 修改 ---------- */

// 修改用到的语句（删除校验里的 getOrderStmt / orderItemsStmt / stockOfSpecStmt 复用删除那套）
const updateOrderStmt = db.prepare(
  `UPDATE inbound_orders
      SET supplier = ?, order_date = ?, remark = ?, warehouse = ?, operator = ?,
          bl_no = ?, contract_no = ?, vehicle_no = ?
    WHERE id = ? AND deleted_at IS NULL`,
)
const replaceOrderItemsStmt = db.prepare(
  `DELETE FROM order_items WHERE order_type = 'in' AND order_id = ?`,
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
 * 校验方式和删除一致，只是把「删掉后」换成「改完后」：
 * 旧明细按 −cubic 计、新明细按 +cubic 计，两者相加就是这次修改对库存的净影响，
 * 任何规格改完为负就整单回滚（防止把已经出掉的货从入库单里改没了）。
 * 单号保持不变，避免和已经打印/登记的凭证对不上。
 */
const updateInbound = db.transaction(
  ({
    id,
    supplier,
    orderDate,
    remark,
    warehouse,
    operator,
    blNo,
    contractNo,
    vehicleNo,
    items,
  }) => {
  const order = getOrderStmt.get(id)
  if (!order) {
    const error = new Error('入库单不存在')
    error.status = 404
    throw error
  }
  // 改动前的这张单金额（用于回报「金额有没有变」）
  const amountBefore = fromCents(
    Number(
      db
        .prepare(
          `SELECT COALESCE(SUM(COALESCE(unit_price_cents, ROUND(unit_price * 100)) * cubic), 0) AS c
             FROM order_items
            WHERE order_type = 'in' AND order_id = ? AND deleted_at IS NULL`,
        )
        .get(id)?.c ?? 0,
    ),
  )

  const deltas = new Map()
  for (const item of orderItemsStmt.all(id)) bumpGroups(deltas, item, -1)
  for (const item of items) bumpGroups(deltas, item, 1)

  const problems = []
  for (const group of deltas.values()) {
    if (group.cubic === 0 && group.bundles === 0) continue

    const stock = stockOfSpecStmt.get(
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

  // ── 重建码单：把这张单原来的包整体替换掉（硬删旧包，再按新明细生成）──
  const oldBales = db
    .prepare(`SELECT id FROM bales WHERE inbound_order_id = ?`)
    .all(id)
  const beforeCents = Number(
    db
      .prepare(
        `SELECT COALESCE(SUM(COALESCE(unit_price_cents, ROUND(unit_price * 100)) * cubic), 0) AS c
           FROM order_items
          WHERE order_type = 'in' AND order_id = ? AND deleted_at IS NULL`,
      )
      .get(id)?.c // 新明细已写入，这里算的是重建后的金额
    ?? 0,
  )
  for (const bale of oldBales) {
    db.prepare(`DELETE FROM bale_items WHERE bale_id = ?`).run(bale.id)
  }
  db.prepare(`DELETE FROM bales WHERE inbound_order_id = ?`).run(id)

  const container = order.shipment_id
    ? db.prepare(`SELECT bl_no FROM shipments WHERE id = ?`).get(order.shipment_id)
    : null
  const barcodes = []
  for (const item of items) {
    barcodes.push(
      ...createBalesForItem({
        item,
        shipmentId: order.shipment_id ?? null,
        shipmentNo: container?.bl_no ?? null,
        inboundOrderId: id,
        inboundOrderNo: order.order_no,
        baleLabels: item.bale_labels,
        samePackage: item.same_package,
      }),
    )
  }
  updateOrderStmt.run(
    supplier,
    orderDate,
    remark || null,
    warehouse,
    operator || null,
    blNo || null,
    contractNo || null,
    vehicleNo || null,
    id,
  )

  return {
    id,
    order_no: order.order_no,
    bale_count: barcodes.length,
    barcodes,
    amount_before: amountBefore,
    amount_after: fromCents(beforeCents),
    amount_changed: Math.abs(amountBefore - fromCents(beforeCents)) > 0.005,
  }
  },
)

// 修改入库单（明细整体替换，单号不变）
router.put('/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '入库单 ID 不合法' })
  }

  const body = req.body ?? {}
  const supplier = String(body.supplier ?? '').trim()
  const orderDate = body.order_date ? String(body.order_date) : todayLocal()
  const remark = body.remark ? String(body.remark) : ''
  const warehouse = String(body.warehouse ?? '').trim()
  const operator = String(body.operator ?? '').trim()
  const blNo = String(body.bl_no ?? '').trim()
  const contractNo = String(body.contract_no ?? '').trim()
  const vehicleNo = String(body.vehicle_no ?? '').trim()
  const rawItems = Array.isArray(body.items) ? body.items : []

  if (!supplier) {
    return res.status(400).json({ error: '供应商不能为空' })
  }
  if (!warehouse) {
    return res.status(400).json({ error: '仓库不能为空' })
  }
  if (rawItems.length === 0) {
    return res.status(400).json({ error: '至少需要一行明细' })
  }

  const items = normalizeItems(rawItems)
  const problems = validateItems(items)
  if (problems.length > 0) {
    return res.status(400).json({ error: problems.join('\n') })
  }

  // ── 整单编辑的前置校验：全部在写库前做完，任何一条不过 → 400，数据一个字不动 ──
  const existing = db
    .prepare(
      `SELECT id, order_no, bl_no, shipment_id FROM inbound_orders
        WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id)
  if (!existing) return res.status(404).json({ error: '入库单不存在' })

  /**
   * 提单号必填——但老单据例外：这张单入库那会儿还没有这条规则，
   * 库里存的就是空，允许它继续空着保存（新建仍然必填）。
   */
  const legacyNoBl = !String(existing.bl_no ?? '').trim()
  if (!blNo && !legacyNoBl) {
    return res.status(400).json({ error: '提单号必填，一票货一个号' })
  }

  const shipped = Number(
    db
      .prepare(
        `SELECT COUNT(*) AS total FROM bales
          WHERE inbound_order_id = ? AND deleted_at IS NULL AND status <> 'in_stock'`,
      )
      .get(id)?.total ?? 0,
  )
  if (shipped > 0) {
    return res.status(400).json({
      error:
        '这张单下有包已经出库了，不能整单编辑。要么先撤销出库，要么走『编辑这一包』',
    })
  }
  try {
    preflightBales({
      shipmentId: existing.shipment_id,
      inboundOrderId: id,
      items,
      excludeOrderId: id,
    })
  } catch (err) {
    return res.status(err.status === 400 ? 400 : 500).json({ error: err.message })
  }

  try {
    res.json(
      updateInbound({
        id,
        supplier,
        orderDate,
        remark,
        warehouse,
        operator,
        blNo,
        contractNo,
        vehicleNo,
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
 * 入库单列表
 * 筛选：单号 / 供应商 / 仓库 / 操作员 / 日期范围（都是可选，模糊匹配用 LIKE）
 * 分页：limit + offset，同时返回 total 供前端显示「共 N 条」和翻页
 */
router.get('/', (req, res) => {
  const {
    order_no: orderNo,
    supplier,
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

  const supplierLike = like(supplier)
  if (supplierLike) {
    conditions.push(`o.supplier LIKE ?`)
    params.push(supplierLike)
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
    db.prepare(`SELECT COUNT(*) AS total FROM inbound_orders o ${where}`).get(...params)
      ?.total ?? 0,
  )
  const { limit, offset } = pageParams(req.query)

  const rows = db
    .prepare(
      `SELECT o.id,
              o.order_no,
              o.supplier,
              o.order_date,
              o.warehouse,
              o.operator,
              o.bl_no,
              o.contract_no,
              o.vehicle_no,
              o.shipment_id,
              c.id                                 AS contract_id,
              (SELECT s.bl_no FROM shipments s
                WHERE s.id = o.shipment_id)        AS bl_no_of_shipment,
              (SELECT COUNT(*) FROM bales b
                WHERE b.inbound_order_id = o.id AND b.deleted_at IS NULL)   AS bale_total,
              (SELECT COUNT(*) FROM bales b
                WHERE b.inbound_order_id = o.id AND b.status = 'in_stock' AND b.deleted_at IS NULL)
                                                   AS bale_in_stock,
              (SELECT COUNT(DISTINCT b.box_no) FROM bales b
                WHERE b.inbound_order_id = o.id AND b.deleted_at IS NULL
                  AND b.box_no IS NOT NULL AND TRIM(b.box_no) <> '')
                                                   AS box_count,
              ROUND(COALESCE(SUM(i.cubic), 0), 4)  AS total_cubic,
              ROUND(COALESCE(SUM(COALESCE(i.amount_cents, ROUND(i.amount * 100))), 0) / 100.0, 2)
                                                   AS total_amount,
              COUNT(i.id)                          AS item_count
         FROM inbound_orders o
         LEFT JOIN order_items i
                ON i.order_id = o.id AND i.order_type = 'in'
         LEFT JOIN contracts c
                ON c.contract_no = o.contract_no AND c.deleted_at IS NULL
        ${where}
        GROUP BY o.id
        ORDER BY o.id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset)

  res.json({ total, limit, offset, rows })
})

// 入库单详情：单头 + 全部明细
router.get('/:id', (req, res) => {
  const id = Number(req.params.id)
  const order = db
    .prepare(`SELECT * FROM inbound_orders WHERE id = ? AND deleted_at IS NULL`)
    .get(id)

  if (!order) {
    return res.status(404).json({ error: '入库单不存在' })
  }

  // 这个合同号在合同库里有的话，把 id 一起给前端，用来渲染可点的链接
  const contract = order.contract_no
    ? db
        .prepare(
          `SELECT id FROM contracts WHERE contract_no = ? AND deleted_at IS NULL`,
        )
        .get(order.contract_no)
    : null

  const items = db
    .prepare(
      `SELECT * FROM order_items
        WHERE order_type = 'in' AND order_id = ? AND deleted_at IS NULL
        ORDER BY id`,
    )
    .all(id)

  // 每行明细对应的包号（编辑表单要能显示出来）：按「规格 + 片数」到这张单的包里反查
  const orderBales = db
    .prepare(
      `SELECT bale_no, species, grade, thickness, width, length, pieces
         FROM bales
        WHERE inbound_order_id = ? AND deleted_at IS NULL
        ORDER BY id`,
    )
    .all(id)
  for (const item of items) {
    const matched = orderBales.filter(
        (bale) =>
          String(bale.species ?? '') === String(item.species ?? '') &&
          String(bale.grade ?? '') === String(item.grade ?? '') &&
          Number(bale.thickness) === Number(item.thickness) &&
          Number(bale.width) === Number(item.width) &&
          Number(bale.length) === Number(item.length) &&
          Number(bale.pieces) === Number(item.pieces),
      ).map((bale) => bale.bale_no)
    // 以明细行自己记的包号为准（精确）；没有才退化成按规格反查（兼容老数据）
    const own = String(item.bale_no ?? '').trim()
    item.bale_labels = own
      ? own.split(/[、,，\s]+/).filter(Boolean)
      : matched
  }

  // 这一单单下每包的状态（在库 / 已出库），入库后随时能看到哪包还没发
  const bales = db
    .prepare(
      `SELECT b.bale_no, b.barcode, b.box_no, b.species, b.grade, b.thickness, b.width, b.length,
              b.pieces, b.cubic, b.status, b.shipped_at,
              o.order_no AS outbound_order_no
         FROM bales b
         LEFT JOIN outbound_orders o ON o.id = b.outbound_order_id
        WHERE b.inbound_order_id = ? AND b.deleted_at IS NULL
        ORDER BY b.bale_no`,
    )
    .all(id)
    .map((row) => ({
      bale_no: row.bale_no,
      barcode: row.barcode ?? row.bale_no ?? '',
      box_no: row.box_no ?? '',
      species: row.species ?? '',
      grade: row.grade ?? '',
      thickness: row.thickness,
      width: row.width,
      length: row.length,
      pieces: row.pieces ?? 0,
      cubic: Number((row.cubic ?? 0).toFixed(4)),
      status: row.status,
      shipped_at: row.shipped_at,
      outbound_order_no: row.outbound_order_no ?? '',
    }))

  // 金额按整数分累加，最后一次性换算成元
  const totals = items.reduce(
    (acc, item) => ({
      total_cubic: Number((acc.total_cubic + (item.cubic ?? 0)).toFixed(4)),
      amountCents:
        acc.amountCents +
        Number(item.amount_cents ?? Math.round((item.amount ?? 0) * 100)),
    }),
    { total_cubic: 0, amountCents: 0 },
  )

  res.json({
    ...order,
    contract_id: contract?.id ?? null,
    total_cubic: totals.total_cubic,
    total_amount: fromCents(totals.amountCents),
    // 柜数（柜号）：同一张单里有几个不同的柜号，系统自己数
    box_count: new Set(
      bales.map((bale) => bale.box_no).filter((box) => box && box.trim() !== ''),
    ).size,
    items,
    bales,
  })
})

/* ---------- 删除 ---------- */

const getOrderStmt = db.prepare(
  `SELECT id, order_no, shipment_id FROM inbound_orders WHERE id = ? AND deleted_at IS NULL`,
)

const orderItemsStmt = db.prepare(
  `SELECT species, grade, thickness, width, length, cubic, bundles
     FROM order_items
    WHERE order_type = 'in' AND order_id = ? AND deleted_at IS NULL`,
)

// 某规格当前库存：入库合计 - 出库合计
const stockOfSpecStmt = db.prepare(
  `SELECT COALESCE(SUM(CASE WHEN order_type = 'in' THEN cubic   ELSE -cubic   END), 0) AS cubic,
          COALESCE(SUM(CASE WHEN order_type = 'in' THEN bundles ELSE -bundles END), 0) AS bundles
     FROM order_items
    WHERE deleted_at IS NULL
      AND species = ?
      AND COALESCE(grade, '') = ?
      AND thickness = ?
      AND width = ?
      AND length = ?`,
)

// 软删除：只打时间戳，明细一起标记，回收站里可以整单恢复
const softDeleteOrderItemsStmt = db.prepare(
  `UPDATE order_items
      SET deleted_at = datetime('now', 'localtime')
    WHERE order_type = 'in' AND order_id = ? AND deleted_at IS NULL`,
)
const softDeleteOrderStmt = db.prepare(
  `UPDATE inbound_orders
      SET deleted_at = datetime('now', 'localtime')
    WHERE id = ? AND deleted_at IS NULL`,
)

// 这批货里已经出库的包数：有的话不允许删入库单
const shippedBaleCountStmt = db.prepare(
  `SELECT COUNT(*) AS total FROM bales
    WHERE inbound_order_id = ? AND status = 'shipped'`,
)
// 包只打删除标记，不真删：回收站恢复单据时，包和条码号要跟着回来
const softDeleteBalesStmt = db.prepare(
  `UPDATE bales SET deleted_at = datetime('now', 'localtime')
    WHERE inbound_order_id = ? AND deleted_at IS NULL`,
)
const packDeleteBalesStmt = db.prepare(
  `DELETE FROM bales WHERE inbound_order_id = ?`,
)
// 这张提单还有几包货（没被删的）
const liveBaleCountStmt = db.prepare(
  `SELECT COUNT(*) AS total FROM bales
    WHERE shipment_id = ? AND deleted_at IS NULL`,
)
const softDeleteShipmentStmt = db.prepare(
  `UPDATE shipments SET deleted_at = datetime('now', 'localtime')
    WHERE id = ? AND deleted_at IS NULL`,
)

// 事务：先校验删完库存会不会变负，通过后再删明细、删单头
const removeInbound = db.transaction((id) => {
  const order = getOrderStmt.get(id)
  if (!order) {
    const error = new Error('入库单不存在')
    error.status = 404
    throw error
  }

  // 这批货已经有包卖出去了就不能删：码单会断链，对不上账
  const shippedNow = Number(shippedBaleCountStmt.get(id)?.total ?? 0)
  if (shippedNow > 0) {
    const error = new Error(
      `无法删除：这张入库单里有 ${shippedNow} 包货已经出库了。` +
        '请先撤销对应的出库单，再删这张入库单。',
    )
    error.status = 400
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

  softDeleteBalesStmt.run(id)
  softDeleteOrderItemsStmt.run(id)
  softDeleteOrderStmt.run(id)

  // 这张提单要是没货了，一并软删（回收站恢复时再跟着回来）
  let removedShipment = null
  if (order.shipment_id && Number(liveBaleCountStmt.get(order.shipment_id)?.total ?? 0) === 0) {
    const ship = db
      .prepare(`SELECT id, bl_no FROM shipments WHERE id = ? AND deleted_at IS NULL`)
      .get(order.shipment_id)
    if (ship) {
      softDeleteShipmentStmt.run(ship.id)
      removedShipment = { id: ship.id, bl_no: ship.bl_no }
    }
  }

  return { order, removedShipment }
})

// 删除入库单
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '入库单 ID 不合法' })
  }

  try {
    const { removedShipment } = removeInbound(id)
    res.json({ ok: true, removed_shipment: removedShipment })
  } catch (err) {
    if (err.status === 400 || err.status === 404) {
      return res.status(err.status).json({ error: err.message })
    }
    res.status(500).json({ error: err.message })
  }
})

export default router
