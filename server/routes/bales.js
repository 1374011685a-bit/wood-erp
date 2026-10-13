import express from 'express'
import { db } from '../db.js'
import { calcCubic } from '../utils/cubic.js'
import { pageParams } from '../utils/paging.js'
import { calcAmountCents, fromCents } from '../utils/cubic.js'

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

/**
 * 手填包号的统一格式：纯数字就补上柜号（7 → A2-007），
 * 这样手填的和自动生成的看起来是同一套号，工人不会拿到两种写法。
 */
function normalizeBaleLabel(label, containerNo) {
  const text = String(label ?? '').trim()
  if (!text) return ''
  if (containerNo && /^\d+$/.test(text)) {
    return buildBaleNo(containerNo, null, Number(text))
  }
  return text
}

/**
 * 从一串包号里取最大的流水号。
 * 认两种写法：`A2-007`（带柜号）和 `7`（老数据里手填的纯数字），其余忽略。
 */
function maxSequence(baleNos) {
  let max = 0
  for (const no of baleNos) {
    const text = String(no ?? '').trim()
    const hit = /^(\d+)$/.exec(text) ?? /-(\d+)\s*$/.exec(text)
    if (hit) max = Math.max(max, Number(hit[1]))
  }
  return max
}

/**
 * 这一柜（或这张入库单）下一个该用的包号流水。
 *
 * 注意不能按 COUNT(*) 算：删掉中间某包之后 COUNT 会变小，
 * 再生成的号就会和已经在用的号撞上（新包被并进老包，规格数据就乱了）。
 * 所以按「已有号里的最大流水 + 1」，删过号也不会重复。
 */
export function nextBaleSequence(containerId, inboundOrderNo) {
  if (containerId) {
    const rows = db
      .prepare(`SELECT bale_no FROM bales WHERE container_id = ?`)
      .all(containerId)
    return maxSequence(rows.map((row) => row.bale_no)) + 1
  }

  const rows = db
    .prepare(
      `SELECT bale_no FROM bales
        WHERE container_id IS NULL AND inbound_order_id IN
              (SELECT id FROM inbound_orders WHERE order_no = ?)`,
    )
    .all(inboundOrderNo)
  return maxSequence(rows.map((row) => row.bale_no)) + 1
}

/** 这一柜已经贴了几张码单（给入库表单做「下一张从几号开始」的提示） */
export function containerBaleInfo(containerId) {
  const rows = db
    .prepare(`SELECT bale_no FROM bales WHERE container_id = ?`)
    .all(containerId)
  return { count: rows.length, next_seq: maxSequence(rows.map((row) => row.bale_no)) + 1 }
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
      ? normalizeBaleLabel(labels[i], containerNo)
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

/* ---------- 码单编辑 / 删除：库存口径在入库单明细上，必须同步 ---------- */

const getBaleStmt = db.prepare(`SELECT * FROM bales WHERE id = ?`)
const baleItemsStmt = db.prepare(
  `SELECT * FROM bale_items WHERE bale_id = ? ORDER BY id`,
)

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
  const row = findOrderItem(orderId, item)
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

/** 往入库单里加一包：规格和片数都对得上就累加，否则新开一行（单价取该规格最近入库价） */
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
  const priceCents = Number(lastPrice?.cents ?? 0)
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

/** 重算码单的汇总列（总立方、总片数、主规格） */
function refreshBaleSummary(baleId) {
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
function normalizeBaleItems(rawItems) {
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
    container_id: bale.container_id,
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
    })),
  })
})

/**
 * 编辑码单：包号 + 规格行。
 * 在库的包才能改；改完把入库单明细同步过去（旧的扣掉、新的挂上），
 * 这样库存汇总和码单永远对得上。已经出库的包不让改，避免动到已发出的货。
 */
const updateBale = db.transaction((id, baleNo, items) => {
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

  const duplicate = db
    .prepare(`SELECT id FROM bales WHERE bale_no = ? AND id <> ?`)
    .get(baleNo, id)
  if (duplicate) {
    const error = new Error(`包号 ${baleNo} 已经被其他包用了`)
    error.status = 400
    throw error
  }

  detachBaleFromOrder(bale)
  db.prepare(`DELETE FROM bale_items WHERE bale_id = ?`).run(id)
  for (const item of items) {
    insertBaleItem.run({
      bale_id: id,
      species: item.species,
      grade: item.grade,
      thickness: item.thickness,
      width: item.width,
      length: item.length,
      pieces: item.pieces,
      cubic: item.cubic,
    })
  }
  db.prepare(`UPDATE bales SET bale_no = ? WHERE id = ?`).run(baleNo, id)
  refreshBaleSummary(id)
  attachBaleToOrder(bale, items)

  return { id, bale_no: baleNo }
})

router.put('/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '码单 ID 不合法' })
  }

  const body = req.body ?? {}
  const baleNo = String(body.bale_no ?? '').trim()
  if (!baleNo) return res.status(400).json({ error: '包号不能为空' })

  const { items, problems } = normalizeBaleItems(body.items)
  if (problems.length > 0) {
    return res.status(400).json({ error: problems.join('\n') })
  }

  try {
    res.json(updateBale(id, baleNo, items))
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
