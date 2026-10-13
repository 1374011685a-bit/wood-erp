import express from 'express'
import { db } from '../db.js'
import { calcCubic } from '../utils/cubic.js'
import { pageParams } from '../utils/paging.js'
import { calcAmountCents, fromCents, toCents } from '../utils/cubic.js'
import { writeLog } from '../boot-log.js'

const router = express.Router()

const roundTo = (value, digits) => Number((value ?? 0).toFixed(digits))

/**
 * 码单列表：一包一条，带上柜号 / 合同号 / 出库单号，
 * 用来查「这包货还在不在、卖给了谁、属于哪个合同」。
 */
const listSql = (where) => `
  SELECT b.*,
         s.bl_no,
         s.contract_no,
         o.order_no AS outbound_order_no
    FROM bales b
    LEFT JOIN shipments s       ON s.id = b.shipment_id
    LEFT JOIN outbound_orders o ON o.id = b.outbound_order_id
   WHERE b.deleted_at IS NULL ${where}
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
      `AND (b.bale_no LIKE ? OR b.barcode LIKE ? OR b.box_no LIKE ?
            OR s.bl_no LIKE ? OR s.contract_no LIKE ?)`,
    )
    params.push(keyword, keyword, keyword, keyword, keyword)
  }

  const status = String(req.query.status ?? '').trim()
  if (status === 'in_stock' || status === 'shipped') {
    conditions.push(`AND b.status = ?`)
    params.push(status)
  }

  const shipmentId = Number(req.query.shipment_id)
  if (Number.isInteger(shipmentId) && shipmentId > 0) {
    conditions.push(`AND b.shipment_id = ?`)
    params.push(shipmentId)
  }

  const species = like(req.query.species)
  if (species) {
    conditions.push(`AND b.species LIKE ?`)
    params.push(species)
  }

  const boxNo = like(req.query.box_no)
  if (boxNo) {
    conditions.push(`AND b.box_no LIKE ?`)
    params.push(boxNo)
  }

  const where = conditions.join(' ')
  const countSql = `
    SELECT COUNT(*) AS total
      FROM bales b
      LEFT JOIN shipments s ON s.id = b.shipment_id
     WHERE b.deleted_at IS NULL ${where}
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
      barcode: row.barcode ?? row.bale_no ?? '',
      shipment_id: row.shipment_id ?? null,
      bl_no: row.bl_no ?? '',
      contract_no: row.contract_no ?? '',
      box_no: row.box_no ?? '',
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
 * 包号查重（录单时失焦就调用）。
 * 范围：传了 shipment_id 就查这张提单，否则查这张入库单（散货）；
 * 都没传（新开的散货单）就没什么可查的，直接返回不重复。
 */
router.get('/check', (req, res) => {
  const baleNo = String(req.query.bale_no ?? '').trim()
  if (!baleNo) return res.json({ exists: false })

  const shipmentId = Number(req.query.shipment_id) || null
  const inboundOrderId = Number(req.query.inbound_order_id) || null
  const scopeKey = baleScopeKey(shipmentId, inboundOrderId)
  if (!scopeKey) return res.json({ exists: false })

  const hit = findBaleInScope.get(scopeKey, baleNo)
  res.json({
    exists: Boolean(hit),
    bale_no: baleNo,
    barcode: hit?.barcode ?? '',
    scope: shipmentId ? '提单' : '入库单',
  })
})

/**
 * 条码号（码单）规则：<提单号>-<3 位流水>，例如 WH-001。
 * 没挂提单的散货就退化成 <入库单号>-<3 位>，保证唯一。
 * 二维码后一版再加，这里先把号生成好。
 */
export function buildBaleNo(shipmentNo, inboundOrderNo, sequence) {
  const prefix = shipmentNo || inboundOrderNo
  return `${prefix}-${String(sequence).padStart(3, '0')}`
}

/**
 * 从一串条码号里取最大的流水号。
 * 认两种写法：`A2-007`（带柜号）和 `7`（老数据里的纯数字），其余忽略。
 */
function maxSequence(barcodes) {
  let max = 0
  for (const no of barcodes) {
    const text = String(no ?? '').trim()
    const hit = /^(\d+)$/.exec(text) ?? /-(\d+)\s*$/.exec(text)
    if (hit) max = Math.max(max, Number(hit[1]))
  }
  return max
}

/**
 * 这张提单（或这张入库单）下一个该用的条码号流水。
 *
 * 注意不能按 COUNT(*) 算：删掉中间某包之后 COUNT 会变小，
 * 再生成的号就会和已经在用的号撞上。
 * 所以按「已有号里的最大流水 + 1」，删过号也不会重复。
 */
export function nextBaleSequence(shipmentId, inboundOrderNo) {
  if (shipmentId) {
    const rows = db
      .prepare(`SELECT barcode FROM bales WHERE shipment_id = ? AND deleted_at IS NULL`)
      .all(shipmentId)
    return maxSequence(rows.map((row) => row.barcode)) + 1
  }

  const rows = db
    .prepare(
      `SELECT barcode FROM bales
        WHERE deleted_at IS NULL AND shipment_id IS NULL AND inbound_order_id IN
              (SELECT id FROM inbound_orders WHERE order_no = ?)`,
    )
    .all(inboundOrderNo)
  return maxSequence(rows.map((row) => row.barcode)) + 1
}

/** 这张提单已经贴了几张码单（给入库表单做「下一个条码号从几开始」的提示） */
export function shipmentBaleInfo(shipmentId) {
  const rows = db
    .prepare(
      `SELECT barcode, box_no FROM bales WHERE shipment_id = ? AND deleted_at IS NULL`,
    )
    .all(shipmentId)
  const boxes = new Set(
    rows.map((row) => String(row.box_no ?? '').trim().toLowerCase()).filter(Boolean),
  )
  return {
    count: rows.length,
    box_count: boxes.size,
    next_seq: maxSequence(rows.map((row) => row.barcode)) + 1,
  }
}

const insertBale = db.prepare(
  `INSERT INTO bales
     (bale_no, shipment_id, inbound_order_id, species, grade,
      thickness, width, length, pieces, cubic, status)
   VALUES
     (@bale_no, @shipment_id, @inbound_order_id, @species, @grade,
      @thickness, @width, @length, @pieces, @cubic, 'in_stock')`,
)

/** 包号查重：同一范围（提单 / 散货按入库单）里找同名包 */
const findBaleInScope = db.prepare(
  `SELECT * FROM bales WHERE scope_key = ? AND bale_no = ? AND deleted_at IS NULL`,
)
export const findBaleByScopeNo = (scopeKey, baleNo) =>
  findBaleInScope.get(scopeKey, baleNo)

/** 这一包在哪个范围里（提单优先，散货按入库单） */
export const baleScopeKey = (shipmentId, inboundOrderId) =>
  shipmentId
    ? `bl:${shipmentId}`
    : inboundOrderId
      ? `order:${inboundOrderId}`
      : ''

/**
 * 写库前先做一遍「预检」，全部通过才允许动数据库。
 *
 * 为什么要在事务之前单独做一遍：这些校验一旦漏到事务里，
 * 触发的就是数据库约束报错（500），而且给用户看到的是一句 SQL 报错，
 * 不是中文提示。预检通过后，事务里只剩纯粹的写入，不会中途失败。
 */

/** 这个柜号现在归谁（提单优先；散货归入库单） */
const boxOwnerStmt = db.prepare(
  `SELECT b.shipment_id, b.inbound_order_id,
          COALESCE(s.bl_no, '入库单 ' || o.order_no) AS owner_no
     FROM bales b
     LEFT JOIN shipments s      ON s.id = b.shipment_id
     LEFT JOIN inbound_orders o ON o.id = b.inbound_order_id
    WHERE b.deleted_at IS NULL
      AND b.box_no IS NOT NULL AND trim(b.box_no) <> ''
      AND lower(trim(b.box_no)) = ?
    LIMIT 1`,
)

/**
 * 柜号跨提单唯一：一个柜只能属于一张提单（散货则属于一张入库单）。
 * 同一个柜里多包填同一个柜号是正常的，不算冲突。
 */
export function assertBoxOwner(boxNo, shipmentId, inboundOrderId) {
  const key = String(boxNo ?? '').trim().toLowerCase()
  if (!key) return

  const owner = boxOwnerStmt.get(key)
  if (!owner) return

  const sameShipment =
    shipmentId && owner.shipment_id && Number(owner.shipment_id) === Number(shipmentId)
  const sameOrder =
    !shipmentId &&
    !owner.shipment_id &&
    inboundOrderId &&
    Number(owner.inbound_order_id) === Number(inboundOrderId)
  if (sameShipment || sameOrder) return

  const error = new Error(
    `柜号 ${String(boxNo).trim()} 已经属于提单 ${owner.owner_no}，不能用在别的提单里`,
  )
  error.status = 400
  throw error
}

export function preflightBales({ shipmentId, inboundOrderId, items, excludeOrderId }) {
  const scopeKey = baleScopeKey(shipmentId, inboundOrderId)
  const where = shipmentId ? '这张提单' : '这张入库单'
  const seen = new Map() // 包号 -> 第一次出现的位置

  items.forEach((item, index) => {
    // 柜号：同一柜可以多包，但不能跨提单
    try {
      assertBoxOwner(item.box_no, shipmentId, inboundOrderId)
    } catch (err) {
      err.message = `第 ${index + 1} 行：${err.message}`
      throw err
    }

    const labels = Array.isArray(item.bale_labels) ? item.bale_labels : []
    if (labels.length === 0) return

    const bundles = Math.round(Number(item.bundles ?? 0))
    // 填了包号就必须和件数对得上（一个包号一包货）
    if (labels.length !== bundles) {
      const error = new Error(
        `第 ${index + 1} 行：件数填了 ${bundles} 件，但填了 ${labels.length} 个包号。请改成一致：` +
          `要么把件数改成 ${labels.length}，要么补齐包号，要么清空包号让系统自动编号`,
      )
      error.status = 400
      throw error
    }

    if (item.same_package === true) return // 同包行是往已有的包里加规格，不参与查重

    for (const label of labels) {
      const key = String(label).trim()
      if (!key) continue
      if (seen.has(key)) {
        const error = new Error(
          `第 ${index + 1} 行：包号 ${key} 在本次录入里重复了（第 ${seen.get(key)} 行已经用过），请换一个包号`,
        )
        error.status = 400
        throw error
      }
      seen.set(key, index + 1)
      const hit = scopeKey ? findBaleInScope.get(scopeKey, key) : null
      const ownBale = hit && excludeOrderId && Number(hit.inbound_order_id) === Number(excludeOrderId)
      if (hit && !ownBale) {
        const error = new Error(`包号 ${key} 在${where}里已存在，请换一个包号`)
        error.status = 400
        throw error
      }
    }
  })
}
const findBaleByBarcode = db.prepare(`SELECT * FROM bales WHERE barcode = ? AND deleted_at IS NULL`)
const insertBaleItem = db.prepare(
  `INSERT INTO bale_items
     (bale_id, species, grade, thickness, width, length, pieces, cubic, unit_price_cents)
   VALUES
     (@bale_id, @species, @grade, @thickness, @width, @length, @pieces, @cubic, @unit_price_cents)`,
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
 * - 包号是工人手打的，照抄货上写的那个号（支持 7 / 7-9 / 7,9,11）；
 *   同一个包号再录一行，表示「这一包还混了别的规格」，规格累加到同一张码单上；
 * - 条码号（就是要打印贴包上的那张码）由系统生成，柜内连续、删号不复用；
 * - 包号留空时：按「件数（=包数）」自动开这么多包，包号先跟条码号一致。
 */
export function createBalesForItem({
  item,
  shipmentId,
  shipmentNo,
  inboundOrderId,
  inboundOrderNo,
  baleLabels,
  /** 这一行是「同包再加一行」：允许往已有的包里追加规格 */
  samePackage,
}) {
  const labels =
    Array.isArray(baleLabels) && baleLabels.length > 0
      ? baleLabels.map((label) => String(label).trim()).filter(Boolean)
      : null
  const bundles = labels ? labels.length : Math.round(Number(item.bundles ?? 0))
  if (!(bundles > 0)) return []

  let sequence = nextBaleSequence(shipmentId, inboundOrderNo)
  const cubicPerBale = roundTo(
    calcCubic(item.thickness, item.width, item.length, item.pieces, 1),
    4,
  )
  const created = []

  /** 取下一个没人用过的条码号 */
  const takeBarcode = () => {
    for (let guard = 0; guard < 1000; guard += 1) {
      const candidate = buildBaleNo(shipmentNo, inboundOrderNo, sequence)
      sequence += 1
      if (!findBaleByBarcode.get(candidate)) return candidate
    }
    const error = new Error('条码号生成失败，请检查提单号 / 单号')
    error.status = 400
    throw error
  }

  for (let i = 0; i < bundles; i += 1) {
    const label = labels ? labels[i] : ''

    // 手填了包号：查重（同一提单 / 同一散货单里包号必须唯一）
    const scopeKey = baleScopeKey(shipmentId, inboundOrderId)
    let bale = label ? findBaleInScope.get(scopeKey, label) : null
    if (bale) {
      // 只有「同包再加一行」这种明确标记过的行，才允许往已有的包里加规格
      // 预检已经把关，这里只是兜底
      if (samePackage !== true) {
        const error = new Error(`包号 ${label} 在这张提单里已存在，请换一个包号`)
        error.status = 400
        throw error
      }
    } else {
      // 预检已经把关，这里只是兜底
      if (samePackage === true) {
        const error = new Error(`「同包再加一行」没找到对应的包号 ${label}，请检查`)
        error.status = 400
        throw error
      }
      const barcode = takeBarcode()
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO bales
             (bale_no, barcode, box_no, shipment_id, inbound_order_id, scope_key,
              species, grade,
              thickness, width, length, pieces, cubic, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_stock')`,
        )
        .run(
          label || barcode,
          barcode,
          item.box_no ?? null,
          shipmentId ?? null,
          inboundOrderId,
          scopeKey,
          item.species,
          item.grade,
          item.thickness,
          item.width,
          item.length,
          item.pieces,
          cubicPerBale,
        )
      bale = { id: Number(lastInsertRowid) }
      created.push(barcode)
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
      unit_price_cents: item.unit_price_cents ?? null,
    })

    if (label) {
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

/* ---------- 码单编辑 / 删除：库存口径在入库单明细上，必须同步 ---------- */

const getBaleStmt = db.prepare(`SELECT * FROM bales WHERE id = ? AND deleted_at IS NULL`)
export const baleItemsStmt = db.prepare(
  `SELECT * FROM bale_items WHERE bale_id = ? ORDER BY id`,
)
export const getBale = (id) => getBaleStmt.get(id)

/** 规格完全一致才认为是同一行 */
const specMatchSql = `
  COALESCE(species, '') = COALESCE(?, '')
  AND COALESCE(grade, '') = COALESCE(?, '')
  AND thickness = ? AND width = ? AND length = ?`

function findOrderItem(orderId, item, pieces) {
  return db
    .prepare(
      `SELECT * FROM order_items
        WHERE order_type = 'in' AND order_id = ? AND deleted_at IS NULL
          AND ${specMatchSql}
          ${pieces === undefined ? '' : 'AND pieces = ?'}
        ORDER BY id
        LIMIT 1`,
    )
    .get(
      orderId,
      item.species,
      item.grade,
      item.thickness,
      item.width,
      item.length,
      ...(pieces === undefined ? [] : [pieces]),
    )
}

/**
 * 从入库单里减掉一包：找到同规格那一行，件数 -1、立方按「厚×宽×长×片数×剩余件数」重算。
 * 减到 0 就把这一行删掉。
 */
function removeOneBundleFromOrder(orderId, item) {
  /**
   * 先按「规格 + 片数」精确匹配，匹配不到再退化成只按规格。
   * 只按规格会在「同一单里同规格但片数不同」时扣错行（加回来是按规格+片数加的，
   * 扣的时候不认片数就会把 200 片那行扣掉、100 片那行留着），两边就对不上了。
   */
  const row =
    findOrderItem(orderId, item, item.pieces) ?? findOrderItem(orderId, item)
  if (!row) return false

  const bundles = Number(row.bundles ?? 0) - 1
  if (bundles <= 0) {
    db.prepare(`DELETE FROM order_items WHERE id = ?`).run(row.id)
    return true
  }

  const cubic = roundTo(
    calcCubic(row.thickness, row.width, row.length, row.pieces, bundles),
    4,
  )
  const priceCents = Number(
    row.unit_price_cents ?? Math.round((row.unit_price ?? 0) * 100),
  )
  const amountCents = calcAmountCents(cubic, priceCents)
  db.prepare(
    `UPDATE order_items
        SET bundles = ?, cubic = ?, amount = ?, amount_cents = ?
      WHERE id = ?`,
  ).run(bundles, cubic, fromCents(amountCents), amountCents, row.id)
  return true
}

/**
 * 往入库单里加一包：规格和片数都对得上就累加，否则新开一行。
 * 单价默认取该规格最近入库价；改包时会把算好的成本价直接传进来（item.unit_price_cents）。
 */
function addOneBundleToOrder(orderId, item) {
  const row = findOrderItem(orderId, item, item.pieces)
  if (row) {
    const bundles = Number(row.bundles ?? 0) + 1
    const cubic = roundTo(
      calcCubic(row.thickness, row.width, row.length, row.pieces, bundles),
      4,
    )
    const priceCents = Number(
      row.unit_price_cents ?? Math.round((row.unit_price ?? 0) * 100),
    )
    const amountCents = calcAmountCents(cubic, priceCents)
    db.prepare(
      `UPDATE order_items
          SET bundles = ?, cubic = ?, amount = ?, amount_cents = ?
        WHERE id = ?`,
    ).run(bundles, cubic, fromCents(amountCents), amountCents, row.id)
    return
  }

  const pinned = Number(item.unit_price_cents)
  let priceCents = Number.isFinite(pinned) ? pinned : NaN
  if (!Number.isFinite(priceCents)) {
    const lastPrice = db
      .prepare(
        `SELECT COALESCE(unit_price_cents, ROUND(unit_price * 100)) AS cents
           FROM order_items
          WHERE order_type = 'in' AND deleted_at IS NULL
            AND ${specMatchSql}
          ORDER BY id DESC
          LIMIT 1`,
      )
      .get(
        item.species,
        item.grade,
        item.thickness,
        item.width,
        item.length,
      )
    priceCents = Number(lastPrice?.cents ?? 0)
  }
  const cubic = roundTo(
    calcCubic(item.thickness, item.width, item.length, item.pieces, 1),
    4,
  )
  const amountCents = calcAmountCents(cubic, priceCents)

  db.prepare(
    `INSERT INTO order_items
       (order_id, order_type, species, grade, thickness, width, length,
        pieces, bundles, cubic, unit_price, amount, unit_price_cents, amount_cents)
     VALUES
       (?, 'in', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  ).run(
    orderId,
    item.species,
    item.grade,
    item.thickness,
    item.width,
    item.length,
    item.pieces,
    cubic,
    fromCents(priceCents),
    fromCents(amountCents),
    priceCents,
    amountCents,
  )
}

/** 把码单的旧规格行从入库单里整体扣掉 */
function detachBaleFromOrder(bale) {
  if (!bale.inbound_order_id) return
  for (const item of baleItemsStmt.all(bale.id)) {
    removeOneBundleFromOrder(bale.inbound_order_id, item)
  }
}

/** 把码单的新规格行挂回入库单 */
function attachBaleToOrder(bale, items) {
  if (!bale.inbound_order_id) return
  for (const item of items) {
    addOneBundleToOrder(bale.inbound_order_id, item)
  }
}

/**
 * 把一包的规格行整体换掉，并同步入库单明细（库存跟着变）。
 * 码单编辑和「改包」都走这里，保证两条路的库存口径一致。
 *
 * 单价处理（财务口径，必须稳）：
 *   1. 调用方给了 unit_price_cents → 直接用它；
 *   2. 没给 → 找这一包「原来的那一行」（规格 + 片数）原价搬过来；
 *   3. 还找不到（就是新加的行）→ 交给 addOneBundleToOrder 用最近入库价兜底。
 * 全程记一笔日志：重建前后金额不一致就打印警告，方便追。
 */
export function replaceBaleItems(bale, items) {
  const amountOf = (list) =>
    list.reduce(
      (sum, line) =>
        sum + calcAmountCents(roundTo(line.cubic ?? 0, 4), Number(line.unit_price_cents ?? 0)),
      0,
    )

  const before = baleItemsStmt.all(bale.id)
  const beforeCents = amountOf(before)

  detachBaleFromOrder(bale)
  db.prepare(`DELETE FROM bale_items WHERE bale_id = ?`).run(bale.id)

  // 每一行最终用哪个单价
  const priced = items.map((item) => {
    const given = Number(item.unit_price_cents)
    if (Number.isFinite(given)) return { ...item, unit_price_cents: given }

    const old = before.find(
      (line) =>
        String(line.species ?? '') === String(item.species ?? '') &&
        String(line.grade ?? '') === String(item.grade ?? '') &&
        Number(line.thickness) === Number(item.thickness) &&
        Number(line.width) === Number(item.width) &&
        Number(line.length) === Number(item.length) &&
        Number(line.pieces) === Number(item.pieces),
    )
    return old?.unit_price_cents === null || old?.unit_price_cents === undefined
      ? item
      : { ...item, unit_price_cents: Number(old.unit_price_cents) }
  })

  for (const item of priced) {
    insertBaleItem.run({
      bale_id: bale.id,
      species: item.species,
      grade: item.grade,
      thickness: item.thickness,
      width: item.width,
      length: item.length,
      pieces: item.pieces,
      cubic: item.cubic,
      unit_price_cents: item.unit_price_cents ?? null,
    })
  }
  refreshBaleSummary(bale.id)
  attachBaleToOrder(bale, priced)

  const afterCents = amountOf(priced)
  if (beforeCents !== afterCents) {
    writeLog(
      `[警告] 码单 ${bale.bale_no || bale.barcode || bale.id} 重建后金额变了：` +
        `${fromCents(beforeCents)} → ${fromCents(afterCents)}（立方没变的话请检查单价）`,
    )
  }

  return { amountBefore: fromCents(beforeCents), amountAfter: fromCents(afterCents) }
}

/** 重算码单的汇总列（总立方、总片数、主规格） */
export function refreshBaleSummary(baleId) {
  const totals = db
    .prepare(
      `SELECT ROUND(COALESCE(SUM(cubic), 0), 4) AS cubic,
              COALESCE(SUM(pieces), 0)         AS pieces
         FROM bale_items WHERE bale_id = ?`,
    )
    .get(baleId)
  const first = baleItemsStmt.all(baleId)[0]

  db.prepare(
    `UPDATE bales
        SET cubic = ?, pieces = ?, species = ?, grade = ?,
            thickness = ?, width = ?, length = ?
      WHERE id = ?`,
  ).run(
    roundTo(totals.cubic ?? 0, 4),
    Number(totals.pieces ?? 0),
    first?.species ?? null,
    first?.grade ?? null,
    first?.thickness ?? null,
    first?.width ?? null,
    first?.length ?? null,
    baleId,
  )
}

/** 校验前端传来的规格行 */
export function normalizeBaleItems(rawItems) {
  const items = Array.isArray(rawItems) ? rawItems : []
  const problems = []

  const normalized = items.map((raw, index) => {
    const species = String(raw.species ?? '').trim()
    const grade = String(raw.grade ?? '').trim()
    const thickness = Number(raw.thickness)
    const width = Number(raw.width)
    const length = Number(raw.length)
    const pieces = Number(raw.pieces)

    const reasons = []
    if (!species) reasons.push('品名不能为空')
    if (!(thickness > 0 && thickness <= 1000)) reasons.push('厚度需在 0~1000mm')
    if (!(width > 0 && width <= 1000)) reasons.push('宽度需在 0~1000mm')
    if (!(length > 0 && length <= 20)) reasons.push('长度需在 0~20m')
    if (!(Number.isInteger(pieces) && pieces > 0)) reasons.push('片数必须是大于 0 的整数')
    if (reasons.length > 0) problems.push(`第 ${index + 1} 行：${reasons.join('；')}`)

    return {
      species,
      grade,
      thickness,
      width,
      length,
      pieces,
      cubic: roundTo(calcCubic(thickness, width, length, pieces, 1), 4),
    }
  })

  if (normalized.length === 0) problems.push('至少需要一个规格')
  return { items: normalized, problems }
}

/** 码单详情（编辑弹窗用） */
router.get('/:id', (req, res) => {
  const id = Number(req.params.id)
  const bale = getBaleStmt.get(id)
  if (!bale) return res.status(404).json({ error: '码单不存在' })

  res.json({
    id: bale.id,
    bale_no: bale.bale_no,
    barcode: bale.barcode ?? bale.bale_no ?? '',
    box_no: bale.box_no ?? '',
    shipment_id: bale.shipment_id ?? null,
    inbound_order_id: bale.inbound_order_id,
    status: bale.status,
    cubic: roundTo(bale.cubic ?? 0, 4),
    pieces: bale.pieces ?? 0,
    items: baleItemsStmt.all(id).map((item) => ({
      id: item.id,
      species: item.species ?? '',
      grade: item.grade ?? '',
      thickness: item.thickness,
      width: item.width,
      length: item.length,
      pieces: item.pieces,
      cubic: roundTo(item.cubic ?? 0, 4),
      unit_price: fromCents(item.unit_price_cents ?? 0),
    })),
  })
})

/**
 * 编辑码单：包号 + 规格行。
 * 在库的包才能改；改完把入库单明细同步过去（旧的扣掉、新的挂上），
 * 这样库存汇总和码单永远对得上。已经出库的包不让改，避免动到已发出的货。
 */
const updateBale = db.transaction((id, baleNo, boxNo, items) => {
  const bale = getBaleStmt.get(id)
  if (!bale) {
    const error = new Error('码单不存在')
    error.status = 404
    throw error
  }
  if (bale.status !== 'in_stock') {
    const error = new Error(`码单 ${bale.bale_no} 已经出库了，不能修改`)
    error.status = 400
    throw error
  }

  // 查重按同一个范围（这张提单 / 这张散货单）比
  const duplicate = findBaleInScope.get(bale.scope_key ?? '', baleNo)
  if (duplicate && duplicate.id !== id) {
    const error = new Error(
      bale.shipment_id
        ? `包号 ${baleNo} 在这张提单里已存在，请换一个包号`
        : `包号 ${baleNo} 在这张入库单里已存在，请换一个包号`,
    )
    error.status = 400
    throw error
  }

  const amounts = replaceBaleItems(bale, items)
  db.prepare(`UPDATE bales SET bale_no = ?, box_no = ? WHERE id = ?`).run(
    baleNo,
    boxNo || null,
    id,
  )

  return {
    id,
    bale_no: baleNo,
    box_no: boxNo,
    // 重建前后金额：前端拿它提示「金额有没有变」
    amount_before: amounts.amountBefore,
    amount_after: amounts.amountAfter,
    amount_changed: amounts.amountBefore !== amounts.amountAfter,
  }
})

router.put('/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '码单 ID 不合法' })
  }

  const body = req.body ?? {}
  const baleNo = String(body.bale_no ?? '').trim()
  if (!baleNo) return res.status(400).json({ error: '包号不能为空' })
  const boxNo = String(body.box_no ?? '').trim()

  const { items, problems } = normalizeBaleItems(body.items)
  if (problems.length > 0) {
    return res.status(400).json({ error: problems.join('\n') })
  }
  // 改柜号也要守「一个柜只能属于一张提单」
  const current = getBaleStmt.get(id)
  if (current && boxNo) {
    try {
      assertBoxOwner(boxNo, current.shipment_id, current.inbound_order_id)
    } catch (err) {
      return res.status(400).json({ error: err.message })
    }
  }

  // 前端把每一行原来的单价回传了：有（>0）就钉住它，没有就交给后端按原行/最近价兜底
  const rawItems = Array.isArray(body.items) ? body.items : []
  const pricedItems = items.map((item, index) => {
    const price = Number(rawItems[index]?.unit_price)
    return Number.isFinite(price) && price > 0
      ? { ...item, unit_price_cents: toCents(price) }
      : item
  })

  try {
    res.json(updateBale(id, baleNo, boxNo, pricedItems))
  } catch (err) {
    if (err.status === 400 || err.status === 404) {
      return res.status(err.status).json({ error: err.message })
    }
    res.status(500).json({ error: err.message })
  }
})

/**
 * 删除码单：同样只能删在库的包，并把入库单明细同步扣掉。
 * 已经出库的包要先撤销对应的出库单。
 */
const removeBale = db.transaction((id) => {
  const bale = getBaleStmt.get(id)
  if (!bale) {
    const error = new Error('码单不存在')
    error.status = 404
    throw error
  }
  if (bale.status !== 'in_stock') {
    const error = new Error(
      `码单 ${bale.bale_no} 已经出库了，不能删除。请先撤销对应的出库单。`,
    )
    error.status = 400
    throw error
  }

  detachBaleFromOrder(bale)
  db.prepare(`DELETE FROM bale_items WHERE bale_id = ?`).run(id)
  db.prepare(`DELETE FROM bales WHERE id = ?`).run(id)
  return { bale_no: bale.bale_no }
})

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '码单 ID 不合法' })
  }

  try {
    res.json({ ok: true, ...removeBale(id) })
  } catch (err) {
    if (err.status === 400 || err.status === 404) {
      return res.status(err.status).json({ error: err.message })
    }
    res.status(500).json({ error: err.message })
  }
})

export default router
