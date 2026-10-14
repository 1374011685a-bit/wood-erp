import express from 'express'
import { db } from '../db.js'
import { pageParams } from '../utils/paging.js'
import { calcAmountCents, calcCubic, toCents, fromCents } from '../utils/cubic.js'
import { requireCap } from '../middleware/permissions.js'
import { seesMoney } from '../permissions.js'
import { expandSlashSpecs } from '../utils/slashSpecs.js'
import {
  attachBaleToOrder,
  baleItemsStmt,
  baleScopeKey,
  BALE_TEXT_COLS,
  baleTextFields,
  detachBaleFromOrder,
  findBaleByScopeNo,
  getBale,
  insertBaleWithItems,
  normalizeBaleItems,
  replaceBaleItems,
  specSegmentsOf,
  takeBarcodes,
  assertBaleNoAvailable,
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

/**
 * 快照里的一行。
 *
 * `length_text` / `pieces_text` 是混装行的原文（`1.8/2.1/2.4`、`17/30/247`）：
 * 这一行在界面上就是一行，撤销 / 编辑时要能原样摆回去，不能只留第一段。
 * 普通行没有斜杠，这两个字段就是单个值。
 */
const snapshotLine = (item, cents) => {
  const specs = Array.isArray(item.specs) ? item.specs : []
  return {
    brand: item.brand ?? '',
    species: item.species ?? '',
    grade: item.grade ?? '',
    thickness: item.thickness,
    width: item.width,
    length: item.length,
    pieces: item.pieces,
    length_text:
      specs.length > 0 ? specs.map((spec) => spec.length).join('/') : String(item.length ?? ''),
    pieces_text:
      specs.length > 0 ? specs.map((spec) => spec.pieces).join('/') : String(item.pieces ?? ''),
    cubic: roundTo(item.cubic ?? 0, 4),
    // 记下这一行当时的成本单价，撤销改包时按原价还原
    unit_price: fromCents(cents ?? 0),
  }
}

const snapshot = (items, centsList = []) =>
  JSON.stringify(items.map((item, index) => snapshotLine(item, centsList[index] ?? 0)))

const parseSnapshot = (text) => {
  if (!text) return []
  try {
    const list = JSON.parse(text)
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/**
 * 改后的快照有两种格式，读的时候要分得清：
 *   - 老格式（改规格）：`[{ species, ... }]` 扁平数组 = 只有一组（一个包）
 *   - 新格式（拆包）  ：`[{ bale_no, barcode, items: [...] }]` 一组一个包
 * 所以统一从这里出去：`items` 永远是「所有规格行摊平」，`bales` 只有拆包才有。
 */
function parseAfterSnapshot(text) {
  const raw = parseSnapshot(text)
  const isGrouped =
    raw.length > 0 &&
    raw[0] &&
    typeof raw[0] === 'object' &&
    Array.isArray(raw[0].items)
  if (!isGrouped) return { bales: null, items: raw }
  return { bales: raw, items: raw.flatMap((group) => group.items ?? []) }
}

const toApi = (row) => ({
  ...(() => {
    const after = parseAfterSnapshot(row.after_json)
    return {
      /** 'spec' 改规格 / 'split' 拆包 */
      kind: row.kind ?? 'spec',
      before_items: parseSnapshot(row.before_json),
      after_items: after.items,
      /** 拆包时才有：改后的每个包（包号 / 条码号 / 规格行） */
      after_bales: after.bales,
      /** 拆出来的包数（改规格固定 1） */
      bale_count: (row.kind === 'split' ? safeParseArray(row.after_bale_ids).length : 1) || 1,
    }
  })(),
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
      /* 斜杠串（长度 / 片数）和列表页共用一个口径，见 bales.js 的 BALE_TEXT_COLS */
      `SELECT b.id, b.bale_no, b.barcode, b.cubic, b.pieces, b.status,
              b.thickness, b.width, b.length,
              b.inbound_order_id,
              s.bl_no, s.contract_no,
              ${BALE_TEXT_COLS}
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
      // 斜杠串：改包选货弹窗的「长度 / 片数」两列直接用它
      ...baleTextFields(row),
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
      before_json, after_json, bl_no, contract_no, created_by,
      kind, after_bale_ids, before_bale_json)
   VALUES
     (@repack_no, @repack_date, @bale_id, @barcode, @bale_no, @container_no,
      @summary, @remark, @before_cubic, @before_amount_cents,
      @after_cubic, @after_amount_cents, @loss_cubic, @price_pinned,
      @before_json, @after_json, @bl_no, @contract_no, @created_by,
      @kind, @after_bale_ids, @before_bale_json)`,
)

const safeParseArray = (text) => {
  if (!text) return []
  try {
    const list = JSON.parse(text)
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/**
 * 前端的「改包后」有两种写法，这里统一成 groups：
 *   - 新格式：`groups: [{ bale_no, items: [...] }, ...]` —— 几组就是几个包
 *   - 老格式：`after_items: [...]` —— 只有一组（改这一包的规格）
 *
 * 一组 = 一个包。`bale_no` 留空就是真的空（不拿条码号顶替）。
 * 每一行可以带斜杠写多段（混装），展开由调用方做。
 */
function readGroups(body) {
  const raw = Array.isArray(body?.groups) ? body.groups : null
  if (raw && raw.length > 0) {
    return raw.map((group) => ({
      baleNo: String(group?.bale_no ?? '').trim(),
      rawItems: Array.isArray(group?.items) ? group.items : [],
    }))
  }

  const flat = Array.isArray(body?.after_items) ? body.after_items : []
  return [
    {
      baleNo: String(body?.bale_no ?? '').trim(),
      rawItems: flat,
    },
  ]
}

/** 快照 → 规格行（补上 cost 单价，单位分） */
const itemsFromSnapshot = (list) =>
  list.map((line) => ({
    ...line,
    unit_price_cents: toCents(line.unit_price ?? 0),
    cubic: roundTo(line.cubic ?? 0, 4),
  }))

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
  /**
   * 改前每一行的成本价（分）。
   *
   * ⚠️ 必须在**动原包之前**取出来：拆包会先把这个包从入库明细里摘掉
   * （那几行 order_items 直接没了），等写完记录再去取价，取到的全是 0。
   * 撤销改包是按这份快照还原的 —— 快照里是 0，撤销回来成本价就变 0
   * （用户报的「撤销后单价、金额全变 0」就是这个原因）。
   */
  const beforePriceList = beforePriceCentsList(bale, overrides, { auto })

  /**
   * 改包后可能有几组 —— 一组就是一个包。
   * 只有一组 = 老行为（改这一包的规格）；两组以上 = 拆包（原包删掉、建几个新包）。
   */
  const groups = payload.groups
  const isSplit = groups.length > 1

  const afterCubic = roundTo(
    groups.reduce(
      (sum, group) => sum + group.rows.reduce((s, row) => s + (row.cubic ?? 0), 0),
      0,
    ),
    4,
  )

  /**
   * 改后单价：填了就以用户填的为准（不再随改前成本变），
   * 没填就按「改前总成本 ÷ 改后总方数」摊到每一行。
   */
  const pinned = groups.some((group) =>
    group.rows.some((row) => Number(row.unit_price) > 0),
  )
  const derivedCents = afterCubic > 0 ? Math.round(beforeCents / afterCubic) : 0
  /**
   * 每一行最终用哪个成本单价（填了用填的，没填用摊出来的）。
   * 再把每一行摊成一条条规格段：混装行（1.8/2.1/2.4）在这里落成三段，
   * 段才是写库存（bale_items / order_items）的最小单位。
   */
  const pricedGroups = groups.map((group) => {
    const rows = group.rows.map((row) => ({
      ...row,
      unit_price_cents: pinned ? toCents(row.unit_price ?? 0) : derivedCents,
    }))
    return { baleNo: group.baleNo, rows, items: specSegmentsOf(rows) }
  })
  const afterCents = pricedGroups.reduce(
    (sum, group) =>
      sum +
      group.rows.reduce((s, row) => s + calcAmountCents(row.cubic ?? 0, row.unit_price_cents), 0),
    0,
  )

  // 提单号 / 合同号：改前的值（留空时同步它）
  const baseContractNo = bale.inbound_order_id
    ? db.prepare(`SELECT contract_no FROM inbound_orders WHERE id = ?`).get(bale.inbound_order_id)?.contract_no ?? null
    : null
  const shipment = bale.shipment_id
    ? db.prepare(`SELECT bl_no FROM shipments WHERE id = ?`).get(bale.shipment_id)
    : null

  // 入库单号：没有提单时条码号用它做前缀
  const inboundOrder = bale.inbound_order_id
    ? db.prepare(`SELECT order_no FROM inbound_orders WHERE id = ?`).get(bale.inbound_order_id)
    : null

  /* ---------- 拆包：原包删掉，按分组建几个新包 ---------- */
  const scopeKey =
    bale.scope_key ?? baleScopeKey(bale.shipment_id, bale.inbound_order_id)
  let createdBales = []
  if (isSplit) {
    // 包号查重：组内不能重名，也不能和这张提单里别的包重名
    // （原包自己不算 —— 它马上要被删掉，用户可以沿用它的包号）
    const seen = new Set()
    for (const group of pricedGroups) {
      const label = group.baleNo
      if (!label) continue
      if (seen.has(label)) {
        const error = new Error(`新包号 ${label} 在这几个新包里重复了，请换一个`)
        error.status = 400
        throw error
      }
      seen.add(label)
      // 包号全局唯一；原包马上要被删掉，所以排除它自己
      assertBaleNoAvailable(label, { excludeBaleId: bale.id })
    }

    /**
     * 先取号，再动原包。
     * 反过来（先删原包）的话，如果原包正好是这张提单里最大的号，
     * 新号会从它的编号重新开始，跟刚撕下来那张已打印的标签撞号。
     */
    const barcodes = takeBarcodes(pricedGroups.length, {
      shipmentId: bale.shipment_id,
      shipmentNo: shipment?.bl_no ?? null,
      inboundOrderNo: inboundOrder?.order_no ?? null,
    })

    // 先把原包从入库明细里扣掉（库存跟着减）
    detachBaleFromOrder(bale)
    db.prepare(`DELETE FROM bale_items WHERE bale_id = ?`).run(bale.id)
    db.prepare(`DELETE FROM bales WHERE id = ?`).run(bale.id)

    pricedGroups.forEach((group, index) => {
      const barcode = barcodes[index]
      const created = insertBaleWithItems({
        // 包号留空就真的空着（不再拿条码号顶替），出库和明细里都显示「—」
        baleNo: group.baleNo || '',
        barcode,
        boxNo: bale.box_no ?? null,
        shipmentId: bale.shipment_id ?? null,
        inboundOrderId: bale.inbound_order_id ?? null,
        items: group.items,
      })
      // 再把新包挂回入库明细（库存跟着加）
      attachBaleToOrder(
        {
          id: created.id,
          bale_no: created.bale_no,
          box_no: bale.box_no ?? null,
          inbound_order_id: bale.inbound_order_id ?? null,
        },
        group.items,
      )
      createdBales.push(created)
    })
  }

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
    // 成本价用的是 hoist 上来的那一份（动原包之前取的），见 beforePriceList
    before_json: snapshot(beforeItems, beforePriceList),
    /**
     * 拆包时 after_json 记成「按包分组」：一组一个包，包号 / 条码号都写进去，
     * 列表和「查看」弹窗直接读它就能把改后长什么样说清楚。
     * 改规格时还是一组，前端按兼容逻辑当单包处理。
     */
    /**
     * 改后记「行」而不是「段」：混装行在界面上一行（1.8/2.1/2.4），
     * 记成段的话，编辑这条记录时会摊成三行 —— 保存下去就变成三个包了。
     */
    after_json: JSON.stringify(
      pricedGroups.map((group, index) => ({
        bale_no: createdBales[index]?.bale_no ?? group.baleNo ?? '',
        barcode: createdBales[index]?.barcode ?? '',
        items: group.rows.map((row) => snapshotLine(row, row.unit_price_cents)),
      })),
    ),
    // 留空就跟改前一致（真正写进记录，不只是显示）
    bl_no: payload.blNo || shipment?.bl_no || null,
    contract_no: payload.contractNo || baseContractNo || null,
    created_by: payload.createdBy || null,
    kind: isSplit ? 'split' : 'spec',
    after_bale_ids: isSplit ? JSON.stringify(createdBales.map((one) => one.id)) : null,
    before_bale_json: isSplit
      ? JSON.stringify({
          id: bale.id,
          bale_no: bale.bale_no,
          barcode: bale.barcode,
          box_no: bale.box_no,
          shipment_id: bale.shipment_id,
          inbound_order_id: bale.inbound_order_id,
          scope_key: scopeKey,
          items: JSON.parse(snapshot(beforeItems, beforePriceList)),
        })
      : null,
  })

  if (!isSplit) {
    /**
     * 改规格的路也可能改了包号（用户在新包号列里填了值）——
     * 不认这个值的话，他改了包号保存，出库那边还是旧包号。
     */
    const newNo = pricedGroups[0].baleNo
    if (newNo && newNo !== (bale.bale_no ?? '')) {
      // 全局唯一（改包号也要走同一套校验，这是用户报的那个 BUG）
      assertBaleNoAvailable(newNo, { excludeBaleId: bale.id })
      db.prepare(`UPDATE bales SET bale_no = ? WHERE id = ?`).run(newNo, bale.id)
      bale.bale_no = newNo
    }
    // 规格换掉，入库明细一起同步（库存跟着变）；
    // 成本单价一并写进去，库存金额才不会因为改包变成 0
    replaceBaleItems(bale, pricedGroups[0].items)
  }

  return {
    id: Number(lastInsertRowid),
    repack_no: payload.repackNo,
    kind: isSplit ? 'split' : 'spec',
    bale_count: isSplit ? createdBales.length : 1,
    bales: createdBales,
  }
})

router.post('/', requireCap('repack.write'), (req, res) => {
  const body = req.body ?? {}
  const baleId = Number(body.bale_id)
  if (!Number.isInteger(baleId) || baleId <= 0) {
    return res.status(400).json({ error: '请先选择要改的包' })
  }

  /**
   * 改包后可能有几组，一组就是一个包：
   *   一组  = 改这一包的规格（老行为）
   *   多组  = 把这一包拆成几个规格统一的包（拆包）
   */
  const rawGroups = readGroups(body)
  if (rawGroups.length === 0) {
    return res.status(400).json({ error: '至少需要一个改包后的规格' })
  }

  /**
   * 一组 = 一个包；组里的一行可以写多段（混装）：
   * 长度 `1.8/2.1/2.4` 配片数 `17/30/247`，后端在落库存时摊成三段。
   */
  const groups = []
  for (let i = 0; i < rawGroups.length; i += 1) {
    const expanded = expandSlashSpecs(rawGroups[i].rawItems)
    const { items, problems } = normalizeBaleItems(expanded.items)
    const all = [...expanded.problems, ...problems]
    if (all.length > 0) {
      const where = rawGroups.length > 1 ? `第 ${i + 1} 包：` : ''
      return res.status(400).json({ error: where + all.join('\n') })
    }
    groups.push({ baleNo: rawGroups[i].baleNo, rows: items })
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
      groups,
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

  /* ---------- 拆包的撤回：删掉新包，把原包重建回来 ---------- */
  if (row.kind === 'split') {
    const snap = (() => {
      try {
        const parsed = JSON.parse(row.before_bale_json ?? 'null')
        return parsed && typeof parsed === 'object' ? parsed : null
      } catch {
        return null
      }
    })()
    if (!snap) {
      const error = new Error('这条拆包记录缺原包快照，没法自动还原，请联系管理员')
      error.status = 400
      throw error
    }

    const newBaleIds = safeParseArray(row.after_bale_ids)
    const newBales = newBaleIds.map((one) => getBale(Number(one))).filter(Boolean)

    // 三道闸：拆出来的包得还在、还没出库、也没被再改过一次
    for (const bale of newBales) {
      if (bale.status !== 'in_stock') {
        const error = new Error(
          `拆出来的包 ${bale.bale_no} 已经出库了，要撤销请先撤销对应的出库单`,
        )
        error.status = 400
        throw error
      }
      const later = db
        .prepare(`SELECT repack_no FROM repacks WHERE bale_id = ? AND id <> ? LIMIT 1`)
        .get(bale.id, id)
      if (later) {
        const error = new Error(
          `拆出来的包 ${bale.bale_no} 之后又改过一次（改包单 ${later.repack_no}），` +
            '请先撤销那一次，再撤销这次拆包',
        )
        error.status = 400
        throw error
      }
    }

    const beforeItems = itemsFromSnapshot(
      Array.isArray(snap.items) ? snap.items : parseSnapshot(row.before_json),
    )

    // ① 新包从入库明细里扣掉
    for (const bale of newBales) detachBaleFromOrder(bale)
    // ② 删掉新包
    for (const bale of newBales) {
      db.prepare(`DELETE FROM bale_items WHERE bale_id = ?`).run(bale.id)
      db.prepare(`DELETE FROM bales WHERE id = ?`).run(bale.id)
    }

    /**
     * ③ 原包号得能重新用。
     * 放在删完新包**之后**查：拆包时允许把原包号给某个新包用（那时原包已被排除），
     * 如果这里提前查，会把「自己拆出来的包」当成占位者，导致永远撤不回去。
     */
    if (snap.bale_no) assertBaleNoAvailable(snap.bale_no)

    // ③ 原包原样重建（包号 / 条码号 / 柜号 / 归属都按快照来）
    //    条码号万一被新包复用走了，重新取一个，别撞号
    let restoredBarcode = snap.barcode
    const barcodeTaken = restoredBarcode
      ? db
          .prepare(`SELECT id FROM bales WHERE barcode = ? AND deleted_at IS NULL`)
          .get(restoredBarcode)
      : null
    if (!restoredBarcode || barcodeTaken) {
      const shipment = snap.shipment_id
        ? db.prepare(`SELECT bl_no FROM shipments WHERE id = ?`).get(snap.shipment_id)
        : null
      const inboundOrder = snap.inbound_order_id
        ? db
            .prepare(`SELECT order_no FROM inbound_orders WHERE id = ?`)
            .get(snap.inbound_order_id)
        : null
      restoredBarcode = takeBarcodes(1, {
        shipmentId: snap.shipment_id ?? null,
        shipmentNo: shipment?.bl_no ?? null,
        inboundOrderNo: inboundOrder?.order_no ?? null,
      })[0]
    }

    const restored = insertBaleWithItems({
      baleNo: snap.bale_no,
      barcode: restoredBarcode,
      boxNo: snap.box_no,
      shipmentId: snap.shipment_id,
      inboundOrderId: snap.inbound_order_id,
      items: beforeItems,
    })
    // ④ 挂回入库明细
    attachBaleToOrder(
      {
        id: restored.id,
        bale_no: restored.bale_no,
        box_no: snap.box_no ?? null,
        inbound_order_id: snap.inbound_order_id ?? null,
      },
      beforeItems,
    )

    db.prepare(`DELETE FROM repacks WHERE id = ?`).run(id)
    return {
      repack_no: row.repack_no,
      restored_bale: restored.bale_no,
      removed_bales: newBales.map((one) => one.bale_no),
    }
  }

  /* ---------- 改规格的撤回：把原规格塞回原来那一包 ---------- */
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
      replaceBaleItems(bale, itemsFromSnapshot(back))
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
