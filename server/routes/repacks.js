import express from 'express'
import { db } from '../db.js'
import { pageParams } from '../utils/paging.js'
import { calcAmountCents, toCents, fromCents } from '../utils/cubic.js'
import { requireCap } from '../middleware/permissions.js'
import { seesMoney } from '../permissions.js'
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
 *
 * 匹配键是「品名 + 等级 + 规格 + 片数」，**不含品牌**（品牌只存不参与匹配）。
 * 万一同一张单里有两行规格完全一样、价格却不同，这里不静默取第一条：
 * 由调用方先让用户在「改包前」里选一个（overrides），否则直接拦下来。
 */
const priceOfItemStmt = db.prepare(
  `SELECT id, brand, COALESCE(unit_price_cents, ROUND(unit_price * 100)) AS cents
     FROM order_items
    WHERE order_type = 'in' AND order_id = ? AND deleted_at IS NULL
      AND COALESCE(species, '') = COALESCE(?, '')
      AND COALESCE(grade, '') = COALESCE(?, '')
      AND thickness = ? AND width = ? AND length = ? AND pieces = ?
    ORDER BY id`,
)

/** 这一行规格能匹配到的成本价候选（按价格去重，带品牌方便用户分辨） */
function priceCandidates(orderId, item) {
  if (!orderId) return []
  const rows = priceOfItemStmt.all(
    orderId,
    item.species,
    item.grade,
    item.thickness,
    item.width,
    item.length,
    item.pieces,
  )

  const byPrice = new Map()
  for (const row of rows) {
    const cents = Number(row.cents ?? 0)
    if (!byPrice.has(cents)) {
      byPrice.set(cents, {
        order_item_id: row.id,
        brand: row.brand ?? '',
        unit_price: fromCents(cents),
        count: 0,
      })
    }
    byPrice.get(cents).count += 1
  }
  return [...byPrice.values()]
}

/**
 * 这一行唯一的成本价（分）：
 * - 匹配不到 → 0
 * - 只有一种价 → 用它
 * - 匹配到多种价 → null（要用户确认，不静默取第一条）
 *
 * @param {{ auto?: boolean }} [options]
 *   auto = true：调用方是「看不到金额的角色」（仓管）。他们前端拿不到候选项，
 *   没法在弹出的下拉里选，再返回 null 就变成了「怎么点都存不了」。
 *   这种情况下取第一条候选价兜底 —— 有据可依、可复现，总比让人卡死强。
 */
function resolvePriceCents(orderId, item, { auto = false } = {}) {
  if (!orderId) return 0
  const candidates = priceCandidates(orderId, item)
  if (candidates.length === 0) return 0
  if (candidates.length === 1) return toCents(candidates[0].unit_price)
  return auto ? toCents(candidates[0].unit_price) : null
}

/** 用户在「改包前」里为某一行选的成本价（分），没选返回 undefined */
function overrideCents(overrides, baleItemId) {
  if (!overrides) return undefined
  const raw = overrides[baleItemId] ?? overrides[String(baleItemId)]
  if (raw === null || raw === undefined || raw === '') return undefined
  const cents = toCents(raw)
  return Number.isFinite(cents) ? cents : undefined
}

function beforeCostCents(bale, overrides = {}, { auto = false } = {}) {
  if (!bale.inbound_order_id) return 0
  let cents = 0
  for (const item of baleItemsStmt.all(bale.id)) {
    const picked = overrideCents(overrides, item.id)
    const unit = picked ?? resolvePriceCents(bale.inbound_order_id, item, { auto }) ?? 0
    cents += calcAmountCents(roundTo(item.cubic ?? 0, 4), unit)
  }
  return cents
}

/** 改前每一行的成本价（分）：用户选过的按用户选的，否则按唯一价 */
function beforePriceCentsList(bale, overrides = {}, { auto = false } = {}) {
  if (!bale.inbound_order_id) return baleItemsStmt.all(bale.id).map(() => 0)
  return baleItemsStmt.all(bale.id).map((item) => {
    const picked = overrideCents(overrides, item.id)
    return picked ?? resolvePriceCents(bale.inbound_order_id, item, { auto }) ?? 0
  })
}

const snapshot = (items, centsList = []) =>
  JSON.stringify(
    items.map((item, index) => ({
      brand: item.brand ?? '',
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
  loss_rate:
    Number(row.before_cubic ?? 0) > 0
      ? Number(((Number(row.loss_cubic ?? 0) / Number(row.before_cubic)) * 100).toFixed(2))
      : null,
  created_by: row.created_by ?? '',
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
      loss_rate:
        Number(sums?.before_cubic ?? 0) > 0
          ? Number((((sums?.loss_cubic ?? 0) / sums.before_cubic) * 100).toFixed(2))
          : null,
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
              b.inbound_order_id,
              s.bl_no, s.contract_no
         FROM bales b
         LEFT JOIN shipments s ON s.id = b.shipment_id
        WHERE b.status = 'in_stock' AND b.deleted_at IS NULL
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
      items: baleItemsStmt.all(row.id).map((item) => {
        const candidates = priceCandidates(row.inbound_order_id, item)
        return {
          id: item.id,
          brand: item.brand ?? '',
          species: item.species ?? '',
          grade: item.grade ?? '',
          thickness: item.thickness,
          width: item.width,
          length: item.length,
          pieces: item.pieces,
          cubic: roundTo(item.cubic ?? 0, 4),
          // 只有一种价就是它；多种价时先给出第一种，同时用 price_ambiguous 标出来让用户选
          unit_price: candidates.length > 0 ? candidates[0].unit_price : 0,
          price_ambiguous: candidates.length > 1,
          price_candidates: candidates.length > 1 ? candidates : undefined,
        }
      }),
    }))

  res.json(rows)
})

/* ---------- 改包 ---------- */

const insertRepack = db.prepare(
  `INSERT INTO repacks
     (repack_no, repack_date, bale_id, barcode, bale_no, container_no,
      summary, remark, before_cubic, before_amount_cents,
      after_cubic, after_amount_cents, loss_cubic, price_pinned,
      before_json, after_json, bl_no, contract_no, created_by)
   VALUES
     (@repack_no, @repack_date, @bale_id, @barcode, @bale_no, @container_no,
      @summary, @remark, @before_cubic, @before_amount_cents,
      @after_cubic, @after_amount_cents, @loss_cubic, @price_pinned,
      @before_json, @after_json, @bl_no, @contract_no, @created_by)`,
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

  /**
   * 改前成本：同一规格在入库明细里匹配到多个价时，不静默取第一条。
   * 用户没在「改包前」里选 → 直接 400，把是哪一行、为什么说清楚。
   *
   * 例外：看不到金额的角色（仓管）前端根本看不到候选价，"选一个"这个动作
   * 他们做不了，再拦就是死路 —— 这类请求走 auto 兜底（取第一条候选价）。
   */
  const auto = payload.autoPickPrice === true
  const overrides = payload.beforePrices ?? {}
  if (bale.inbound_order_id && !auto) {
    const unresolved = beforeItems.findIndex(
      (item) =>
        resolvePriceCents(bale.inbound_order_id, item) === null &&
        overrideCents(overrides, item.id) === undefined,
    )
    if (unresolved >= 0) {
      const item = beforeItems[unresolved]
      const error = new Error(
        `第 ${unresolved + 1} 行（${item.species} ${item.grade} ` +
          `${item.thickness}×${item.width}×${item.length}，${item.pieces} 片）` +
          '在入库明细里匹配到多个成本价，请在「改包前」里选一个再保存',
      )
      error.status = 400
      throw error
    }
  }
  const beforeCents = beforeCostCents(bale, overrides, { auto })

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

  // 提单号 / 合同号：改前的值（留空时同步它）
  const baseContractNo = bale.inbound_order_id
    ? db.prepare(`SELECT contract_no FROM inbound_orders WHERE id = ?`).get(bale.inbound_order_id)?.contract_no ?? null
    : null
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
      beforePriceCentsList(bale, overrides, { auto }),
    ),
    after_json: snapshot(payload.items, afterPriceCents),
    // 留空就跟改前一致（真正写进记录，不只是显示）
    bl_no: payload.blNo || shipment?.bl_no || null,
    contract_no: payload.contractNo || baseContractNo || null,
    created_by: payload.createdBy || null,
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

router.post('/', requireCap('repack.write'), (req, res) => {
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
      // 「改包前」里为某一行手选的成本价：{ [bale_item_id]: 单价 }
      beforePrices: body.before_prices ?? {},
      /**
       * 看不到金额的角色没法在「改包前」里挑成本价（候选项不返回给他们），
       * 交给后端取第一条候选价兜底，否则他们点保存只会一直报「请先选一个」。
       */
      autoPickPrice: !seesMoney(req.user.role),
      createdBy: req.user?.username ?? '',
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

router.delete('/:id', requireCap('repack.write'), (req, res) => {
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
