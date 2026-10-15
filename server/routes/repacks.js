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

/**
 * 改前每一行的成本价（分）。
 *
 * 一包可能混了好几张入库单的货（多包合并出来的），所以**逐行按这一行自己的来源单**
 * 去解析成本价，不能拿"某一个包的单号"去查全部行。
 */
function beforePriceCentsList(lines, overrides = {}, { auto = false } = {}) {
  return lines.map((item) => {
    const picked = overrideCents(overrides, item.id)
    if (picked !== undefined) return picked
    const orderId = Number(item.src_inbound_order_id ?? 0)
    if (!orderId) return 0
    return resolvePriceCents(orderId, item, { auto }) ?? 0
  })
}

/** 改前总成本（分）= 每一行的 立方 × 这一行的成本价 */
const beforeCostCents = (lines, centsList) =>
  lines.reduce(
    (sum, item, index) =>
      sum + calcAmountCents(roundTo(item.cubic ?? 0, 4), centsList[index] ?? 0),
    0,
  )

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
    /**
     * 这一行来自哪张入库单 / 哪个源包。
     * 合并改包时一包里会混好几张单的货，撤销要按来源各回各的单；
     * 「查看」弹窗也要靠 `src_bale_no` 把每一行归回原包。
     */
    ...(Number(item.src_inbound_order_id ?? 0) > 0
      ? { src_inbound_order_id: Number(item.src_inbound_order_id) }
      : {}),
    ...(Number(item.src_bale_id ?? 0) > 0 ? { src_bale_id: Number(item.src_bale_id) } : {}),
    ...(Number(item.srcBaleId ?? 0) > 0 && Number(item.src_bale_id ?? 0) === 0
      ? { src_bale_id: Number(item.srcBaleId) }
      : {}),
    ...(item.src_bale_no ? { src_bale_no: String(item.src_bale_no) } : {}),
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
 * 原包快照 → 源包数组。
 *
 * 新格式：`{ bales: [ { id, bale_no, barcode, box_no, shipment_id, inbound_order_id, items:[…] } ] }`
 *   —— 多选改包时，一个记录对应多个源包。
 * 老格式：就是**一个包对象**（单包改包的历史记录），当成单元素数组。
 */
function readSourceSnapshots(text) {
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return []
    if (Array.isArray(parsed.bales)) return parsed.bales.filter(Boolean)
    // 老记录：单个包对象
    if (parsed.id && Array.isArray(parsed.items)) return [parsed]
    return []
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
    const sources = readSourceSnapshots(row.before_bale_json)
    return {
      /** 'spec' 改规格 / 'split' 拆包 */
      kind: row.kind ?? 'spec',
      before_items: parseSnapshot(row.before_json),
      after_items: after.items,
      /** 拆包时才有：改后的每个包（包号 / 条码号 / 规格行） */
      after_bales: after.bales,
      /** 拆出来的包数（改规格固定 1） */
      bale_count: (row.kind === 'split' ? safeParseArray(row.after_bale_ids).length : 1) || 1,
      /** 这次改了几个源包（多选改包 ≥ 2）；列表 / 查看显示「N 包 → M 包」用 */
      source_bale_count: sources.length || 1,
      /** 源包号（空的跳过） */
      source_bale_nos: sources.map((one) => one.bale_no).filter(Boolean),
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
        /**
         * 成本价按**这一行自己的来源单**查：一包里可能混了好几张单的货，
         * 拿包的主单号去查会查错/查不到（多包合并之后就会这样）。
         */
        const srcOrderId = item.src_inbound_order_id ?? row.inbound_order_id
        const candidates = priceCandidates(srcOrderId, item)
        return {
          id: item.id,
          src_inbound_order_id: item.src_inbound_order_id ?? null,
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

/** 提单号（shipments.bl_no）：按单号查 */
const blNoOfShipment = db.prepare(`SELECT bl_no FROM shipments WHERE id = ?`)
/** 合同号 / 单号：按入库单查 */
const orderBriefStmt = db.prepare(
  `SELECT order_no, contract_no, shipment_id FROM inbound_orders WHERE id = ?`,
)

/** 去重后取「有值的那些」 */
const distinctValues = (list) =>
  [...new Set(list.filter((one) => one !== null && one !== undefined && String(one).trim() !== ''))]

/** 规格完全一致（品名 / 等级 / 厚 / 宽 / 长 / 片数）—— 用来把手填的行认回它原来的来源 */
const sameSpecLine = (a, b) =>
  String(a.species ?? '') === String(b.species ?? '') &&
  String(a.grade ?? '') === String(b.grade ?? '') &&
  Number(a.thickness) === Number(b.thickness) &&
  Number(a.width) === Number(b.width) &&
  Number(a.length) === Number(b.length) &&
  Number(a.pieces) === Number(b.pieces)

const createRepack = db.transaction((payload) => {
  /* ---------- 源包：1 个（老行为）或多个（多选改包） ---------- */
  const sources = payload.baleIds.map((id) => {
    const bale = getBale(id)
    if (!bale) {
      const error = new Error(`要改的包里有不存在的（id=${id}），请重新选择`)
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
    return bale
  })
  const sourceIds = sources.map((bale) => bale.id)
  const primary = sources[0]

  /**
   * 改前的规格行：所有源包的行摊平，每行标上「来自哪个包、哪张单」。
   * 包是物理的（可以随便合并），账是按行走的 —— 这一份就是账的依据。
   */
  const beforeItems = sources.flatMap((bale) =>
    baleItemsStmt.all(bale.id).map((item) => ({
      ...item,
      src_bale_id: bale.id,
      src_bale_no: bale.bale_no ?? '',
      src_inbound_order_id: item.src_inbound_order_id ?? bale.inbound_order_id ?? null,
    })),
  )
  const beforeCubic = roundTo(
    beforeItems.reduce((sum, item) => sum + (item.cubic ?? 0), 0),
    4,
  )

  /**
   * 一段规格属于哪张入库单（顺序即优先级）：
   *   ① 段自己带的来源（后端内部继承下来的）
   *   ② 前端提示的源包（复制改包前数据 / 一键拆包出来的行会带 srcBaleId）
   *   ③ 按「规格 + 片数」在改前的行里找（手填的行也能归位）
   *   ③b 只按「规格」（不管片数）再找一次 —— 常见场景：一包 20 片被拆成两行各 10 片，
   *       片数对不上但规格是同一个，这时也要认回原来那张单
   *   ④ 兜底：第一个源包那张单
   */
  const sourceOrderOfSegment = (segment) => {
    if (Number(segment.src_inbound_order_id ?? 0) > 0) {
      return Number(segment.src_inbound_order_id)
    }
    const hint = Number(segment.srcBaleId ?? segment.src_bale_id ?? 0)
    if (hint > 0) {
      const hit = sources.find((bale) => bale.id === hint)
      if (hit) return hit.inbound_order_id ?? null
    }
    const matched =
      beforeItems.find((line) => sameSpecLine(line, segment)) ??
      beforeItems.find(
        (line) =>
          String(line.species ?? '') === String(segment.species ?? '') &&
          String(line.grade ?? '') === String(segment.grade ?? '') &&
          Number(line.thickness) === Number(segment.thickness) &&
          Number(line.width) === Number(segment.width) &&
          Number(line.length) === Number(segment.length),
      )
    if (matched) return matched.src_inbound_order_id ?? null
    return primary.inbound_order_id ?? null
  }

  /**
   * 改前成本：同一规格在入库明细里匹配到多个价时，不静默取第一条。
   * 用户没在「改包前」里选 → 直接 400，把是哪一行、为什么说清楚。
   *
   * 例外：看不到金额的角色（仓管）前端根本看不到候选价，"选一个"这个动作
   * 他们做不了，再拦就是死路 —— 这类请求走 auto 兜底（取第一条候选价）。
   */
  const auto = payload.autoPickPrice === true
  const overrides = payload.beforePrices ?? {}
  if (!auto) {
    const unresolved = beforeItems.findIndex(
      (item) =>
        Number(item.src_inbound_order_id ?? 0) > 0 &&
        resolvePriceCents(Number(item.src_inbound_order_id), item) === null &&
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
  /**
   * 改前每一行的成本价（分）。
   *
   * ⚠️ 必须在**动源包之前**取出来：拆包会先把这些包从入库明细里摘掉
   * （那几行 order_items 直接没了），等写完记录再去取价，取到的全是 0。
   * 撤销改包是按这份快照还原的 —— 快照里是 0，撤销回来成本价就变 0
   * （用户报的「撤销后单价、金额全变 0」就是这个原因）。
   */
  const beforePriceList = beforePriceCentsList(beforeItems, overrides, { auto })
  const beforeCents = beforeCostCents(beforeItems, beforePriceList)

  /**
   * 改包后可能有几组 —— 一组就是一个包。
   *
   * 「1 个源包 → 1 个新包」= 老行为：包还是那个包，只把规格换掉（包号 / 条码号不动）。
   * 其余情况（多包并一包、一包拆几包、多包重排）= 源包全部删掉，按组新建。
   */
  const groups = payload.groups
  const isSplit = !(sources.length === 1 && groups.length === 1)

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
    /**
     * 每一段规格属于哪张入库单：
     *   ① 行/段自己带的来源（后端内部调用、或上一轮继承下来的）
     *   ② 前端提示的源包（「复制改包前数据」「一键拆包」出来的行会带）
     *   ③ 按「规格 + 片数」在改前的行里找（手填的行也能归位）
     *   ④ 兜底：第一个源包那张单
     * —— 这一步就是"包只管物理、财务按来源分开"的落点：新包里的每一段，
     *    库存都记到它本来那张单上。
     */
    const items = specSegmentsOf(rows).map((segment) => ({
      ...segment,
      src_inbound_order_id: sourceOrderOfSegment(segment),
    }))
    return { baleNo: group.baleNo, rows, items }
  })
  const afterCents = pricedGroups.reduce(
    (sum, group) =>
      sum +
      group.rows.reduce((s, row) => s + calcAmountCents(row.cubic ?? 0, row.unit_price_cents), 0),
    0,
  )

  /**
   * 「改包丢货」的后端闸。
   *
   * 改包的实现是：源包全部删掉，再按「改包后」的行重建新包 ——
   * 所以只要某个源包的规格行没被列进「改包后」，那一份货就会**从账上消失**
   * （入库明细被扣光、库存跟着少）。前端保存前会弹确认，这里兜住直接调接口的情况：
   * 差 > 0.0001 且没带 force → 400。
   *
   * 判法和前端完全一致：
   *   ① 段上带来源包标记（srcBaleId / src_bale_id）→ 直接算给那一包
   *   ② 手填的段（没标记）→ 按规格匹配这一包还没被覆盖的规格行，同规格只算一次
   */
  const afterSegments = pricedGroups.flatMap((group) => group.items)
  const srcBaleOf = (item) => Number(item?.srcBaleId ?? item?.src_bale_id ?? 0)
  const sameSpec = (line, seg) =>
    String(line.species ?? '') === String(seg.species ?? '') &&
    String(line.grade ?? '') === String(seg.grade ?? '') &&
    Number(line.thickness) === Number(seg.thickness) &&
    Number(line.width) === Number(seg.width) &&
    Number(line.length) === Number(seg.length) &&
    Number(line.pieces) === Number(seg.pieces)

  const discarded = []
  for (const bale of sources) {
    const lines = beforeItems.filter((item) => item.src_bale_id === bale.id)
    const total = roundTo(lines.reduce((sum, line) => sum + Number(line.cubic ?? 0), 0), 4)
    if (total <= 0) continue
    let covered = 0
    for (const seg of afterSegments) {
      if (srcBaleOf(seg) === bale.id) covered += Number(seg.cubic ?? 0)
    }
    const rest = [...lines]
    for (const seg of afterSegments) {
      if (srcBaleOf(seg) > 0) continue
      const at = rest.findIndex((line) => sameSpec(line, seg))
      if (at < 0) continue
      covered += Number(rest[at].cubic ?? 0)
      rest.splice(at, 1)
    }
    const gap = roundTo(total - covered, 4)
    if (gap > 0.0001) {
      discarded.push({
        blNo: blNoOfShipment.get(bale.shipment_id)?.bl_no ?? '',
        baleNo: bale.bale_no ?? '',
        gap,
        specs: (rest.length > 0 ? rest : lines).map(
          (line) => `${line.thickness}×${line.width}×${line.length} / ${line.pieces}片`,
        ),
      })
    }
  }
  if (discarded.length > 0) {
    /**
     * 改包**只允许重组，不允许丢货**（没有"确认丢弃"这条路）。
     * 想改数量请去编辑入库单 —— 那是唯一会改「原」的入口。
     */
    const error = new Error(
      discarded
        .map(
          (one) =>
            `源包 ${one.baleNo || '—'}（提单 ${one.blNo || '—'}）的 ${one.gap} 方` +
            '没有被分配到任何新包里，请检查改包后的行。' +
            '如果确实要丢弃，请先编辑入库单修改数量，不要用改包丢货。',
        )
        .join('；'),
    )
    error.status = 400
    throw error
  }

  /**
   * 新包要继承的东西（逐组算）：
   *   提单号 / 合同号：**表单不填，系统自动挂**（和千木云一样，改包页只有备注）
   *     · 来源一致 → 挂那一张
   *     · 来源不一致（跨提单 / 跨合同合并）→ 挂**第一个源包**那一张
   *     物理上挂谁的提单不改财务归属：入库明细（账）还是按每行的来源单各挂各的
   *     （见 attachBaleToOrder），所以原提单的「原」立方一分不动。
   *   柜号：来源一致就继承，不一致就留空（保存后可在「采购入库明细」里单独编辑这一包补上）
   *   入库单：取这一组第一段来源的那张单（列表/明细按它显示，账仍按行走）
   */
  /** 「第一个源包」那一张：提单 / 合同不一致时都挂它 */
  const primaryContractNo =
    String(orderBriefStmt.get(primary.inbound_order_id)?.contract_no ?? '').trim() || null

  const groupMeta = pricedGroups.map((group, index) => {
    const orderIds = distinctValues(
      group.items.map((item) => item.src_inbound_order_id),
    ).map(Number)
    const orders = orderIds.map((id) => orderBriefStmt.get(id)).filter(Boolean)

    /* 这一组是从哪几个源包来的（前端有提示就用提示，没有就按来源单反推） */
    const hinted = distinctValues(
      group.rows.map((row) => row.srcBaleId ?? row.src_bale_id),
    ).map(Number)
    const groupSources =
      hinted.length > 0
        ? sources.filter((bale) => hinted.includes(bale.id))
        : sources.filter((bale) => orderIds.includes(Number(bale.inbound_order_id)))

    /* 柜号：一致就继承，不一致留空 */
    const boxNos = distinctValues(groupSources.map((bale) => bale.box_no))
    const boxNo = boxNos.length === 1 ? boxNos[0] : null

    /* 提单：来源一致挂那一张，跨提单合并挂第一个源包的 */
    const shipmentIds = distinctValues(orders.map((one) => one.shipment_id))
      .filter((one) => one != null)
      .map(Number)
    const shipmentId =
      shipmentIds.length === 1 ? shipmentIds[0] : (primary.shipment_id ?? shipmentIds[0] ?? null)

    /* 合同号：同规则 */
    const contractNos = distinctValues(orders.map((one) => one.contract_no))
      .map((one) => String(one ?? '').trim())
      .filter(Boolean)
    const contractNo =
      contractNos.length === 1 ? contractNos[0] : (primaryContractNo || contractNos[0] || null)

    return {
      baleNo: group.baleNo,
      items: group.items,
      rows: group.rows,
      shipmentId,
      contractNo,
      boxNo,
      // 主入库单：这一组第一段来源的那张单
      inboundOrderId: orderIds[0] ?? primary.inbound_order_id ?? null,
      index,
    }
  })
  const groupByIndex = groupMeta

  /** 记录上显示的提单号 / 合同号：各组一致就用它，否则用第一个源包的（和实际挂的一致） */
  const allShipmentIds = distinctValues(groupByIndex.map((one) => one.shipmentId)).map(Number)
  const allContractNos = distinctValues(groupByIndex.map((one) => one.contractNo))
  const recordBlNo =
    (allShipmentIds.length === 1 ? blNoOfShipment.get(allShipmentIds[0])?.bl_no ?? null : null) ||
    (primary.shipment_id ? blNoOfShipment.get(primary.shipment_id)?.bl_no ?? null : null)
  const recordContractNo =
    (allContractNos.length === 1 ? allContractNos[0] : null) || primaryContractNo

  /* ---------- 源包删掉，按分组建新包 ---------- */
  let createdBales = []
  if (isSplit) {
    // 包号查重：组内不能重名，也不能和库里活着的包重名
    // （这几个源包不算 —— 它们马上要被删掉，用户可以沿用原来的包号）
    const seen = new Set()
    for (const group of groupByIndex) {
      const label = group.baleNo
      if (!label) continue
      if (seen.has(label)) {
        const error = new Error(`新包号 ${label} 在这几个新包里重复了，请换一个`)
        error.status = 400
        throw error
      }
      seen.add(label)
      // 包号全局唯一；源包马上要被删掉，所以排除它们
      assertBaleNoAvailable(label, { excludeBaleIds: sourceIds })
    }

    /**
     * 先取号，再动源包。
     * 反过来（先删源包）的话，如果源包正好是这张提单里最大的号，
     * 新号会从它的编号重新开始，跟刚撕下来那张已打印的标签撞号。
     *
     * 取号上下文 = **条码号前缀的来源**：
     *   有提单 → 前缀取提单号（同一张提单下的所有新包共用一个池）
     *   没提单（散货）→ 前缀取入库单号（按单分池）
     * 同一个池一次取够，避免两组各自计算序列、拿到同一个号。
     */
    const contextKey = (meta) =>
      meta.shipmentId ? `s${meta.shipmentId}` : `o${meta.inboundOrderId ?? 'x'}`
    const barcodePool = new Map()
    const barcodes = groupByIndex.map((meta) => {
      const key = contextKey(meta)
      if (!barcodePool.has(key)) {
        const sameContext = groupByIndex.filter((one) => contextKey(one) === key)
        barcodePool.set(
          key,
          takeBarcodes(sameContext.length, {
            // 同一组里的提单是同一个，取第一组的上下文就够
            shipmentId: meta.shipmentId ?? null,
            shipmentNo: meta.shipmentId
              ? blNoOfShipment.get(meta.shipmentId)?.bl_no ?? null
              : null,
            inboundOrderNo: meta.inboundOrderId
              ? orderBriefStmt.get(meta.inboundOrderId)?.order_no ?? null
              : null,
          }),
        )
      }
      return barcodePool.get(key).shift()
    })

    // 先把源包从各自的入库明细里扣掉（库存跟着减），再删包
    for (const bale of sources) detachBaleFromOrder(bale)
    for (const bale of sources) {
      db.prepare(`DELETE FROM bale_items WHERE bale_id = ?`).run(bale.id)
      db.prepare(`DELETE FROM bales WHERE id = ?`).run(bale.id)
    }

    groupByIndex.forEach((group, index) => {
      const barcode = barcodes[index]
      const created = insertBaleWithItems({
        // 包号留空就真的空着（不再拿条码号顶替），出库和明细里都显示「—」
        baleNo: group.baleNo || '',
        barcode,
        // 柜号：这一组来源一致就继承，不一致就是空（用户之后可单独编辑这一包补上）
        boxNo: group.boxNo,
        shipmentId: group.shipmentId,
        inboundOrderId: group.inboundOrderId,
        items: group.items,
      })
      // 再把新包挂回入库明细（库存跟着加）
      attachBaleToOrder(
        {
          id: created.id,
          bale_no: created.bale_no,
          box_no: group.boxNo,
          inbound_order_id: group.inboundOrderId,
        },
        group.items,
      )
      createdBales.push(created)
    })
  }

  const { lastInsertRowid } = insertRepack.run({
    repack_no: payload.repackNo,
    repack_date: payload.repackDate,
    // 记录挂在**第一个源包**上（列表 / 查看 / 编辑按它定位）
    bale_id: primary.id,
    barcode: primary.barcode ?? primary.bale_no ?? '',
    // 多选时把源包号列出来（空包号跳过），界面上显示成「A2、A5」
    bale_no: sources.map((one) => one.bale_no ?? '').filter(Boolean).join('、'),
    container_no: recordBlNo,
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
    bl_no: recordBlNo,
    contract_no: recordContractNo,
    created_by: payload.createdBy || null,
    kind: isSplit ? 'split' : 'spec',
    after_bale_ids: isSplit ? JSON.stringify(createdBales.map((one) => one.id)) : null,
    /**
     * 原包快照：**数组**（多选改包时是多个源包）。
     * 每一行都带着 `src_inbound_order_id`，撤销时按来源各回各的单。
     * 老记录里这个字段是「一个对象」，读取时按单元素数组兼容（见 readSourceSnapshots）。
     */
    before_bale_json: isSplit
      ? JSON.stringify({
          bales: sources.map((bale) => ({
            id: bale.id,
            bale_no: bale.bale_no,
            barcode: bale.barcode,
            box_no: bale.box_no,
            shipment_id: bale.shipment_id,
            inbound_order_id: bale.inbound_order_id,
            scope_key: bale.scope_key ?? baleScopeKey(bale.shipment_id, bale.inbound_order_id),
            items: beforeItems
              .map((line, lineIndex) => ({ line, cents: beforePriceList[lineIndex] ?? 0 }))
              .filter(({ line }) => line.src_bale_id === bale.id)
              .map(({ line, cents }) => snapshotLine(line, cents)),
          })),
        })
      : null,
  })

  if (!isSplit) {
    /**
     * 改规格的路也可能改了包号（用户在新包号列里填了值）——
     * 不认这个值的话，他改了包号保存，出库那边还是旧包号。
     */
    const newNo = pricedGroups[0].baleNo
    if (newNo && newNo !== (primary.bale_no ?? '')) {
      // 全局唯一（改包号也要走同一套校验，这是用户报的那个 BUG）
      assertBaleNoAvailable(newNo, { excludeBaleId: primary.id })
      db.prepare(`UPDATE bales SET bale_no = ? WHERE id = ?`).run(newNo, primary.id)
      primary.bale_no = newNo
    }
    // 规格换掉，入库明细一起同步（库存跟着变）；
    // 成本单价一并写进去，库存金额才不会因为改包变成 0
    replaceBaleItems(primary, pricedGroups[0].items)
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
  /**
   * 源包：多选传 `bale_ids`（数组）；单包调用（老前端 / 脚本）继续接受 `bale_id`。
   * 去重 + 过滤非法值，顺序保持用户选的样子（第一个当"主包"）。
   */
  const rawIds = Array.isArray(body.bale_ids)
    ? body.bale_ids
    : body.bale_id !== undefined
      ? [body.bale_id]
      : []
  const baleIds = [...new Set(rawIds.map(Number).filter((one) => Number.isInteger(one) && one > 0))]
  if (baleIds.length === 0) {
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
      baleIds,
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

/**
 * 撤销一条改包记录。
 *
 * `options.renames`（可选）：`{ [源包 id]: '新包号' }`。
 * 只在「源包号被别人占了」这条路上用到 —— 前端拿到 409 的冲突清单后，
 * 让用户当场填新号，再带着这份 renames 重发一次。
 */
const removeRepack = db.transaction((id, options = {}) => {
  const row = db.prepare(`SELECT * FROM repacks WHERE id = ?`).get(id)
  if (!row) {
    const error = new Error('这条改包记录不存在')
    error.status = 404
    throw error
  }

  /* ---------- 拆包 / 合并 / 重排的撤回：删掉新包，把**每个源包**重建回来 ---------- */
  if (row.kind === 'split') {
    const snaps = readSourceSnapshots(row.before_bale_json)
    if (snaps.length === 0) {
      const error = new Error('这条改包记录缺原包快照，没法自动还原，请联系管理员')
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

    /* 快照里没带规格行的话（极少见），退回用 before_json 里那一份摊平 */
    const fallbackItems = itemsFromSnapshot(parseSnapshot(row.before_json))

    /**
     * ── 源包号的查重 + 改号 ──
     *
     * 撤销要把源包原样重建回来，包号也得回来。但那个号可能已经被别人占了
     * （单子改包之后那个号腾出来了，别处又拿去用了）—— 直接重建会撞全局唯一索引。
     *
     * 这种时候不再硬报一句「包号 X 已经存在，请换一个」把人晾住（撤销弹窗里
     * 根本没有包子号输入框），而是回 409 带上冲突清单（`code: 'BALE_NO_TAKEN'`），
     * 让前端**当场让用户填新号**，填完带 `renames` 重发。
     *
     * 查重放在删新包之前（fail fast，一行都不写），但要把「这次拆出来的新包」
     * 排除掉：改包时允许把源包号给新包用，不排除就会把它们当成占位者，
     * 导致永远撤不回去。
     */
    const renames = options.renames ?? {}
    const plan = snaps.map((snap) => {
      const originalNo = String(snap.bale_no ?? '').trim()
      const baleNo =
        renames[snap.id] === undefined ? originalNo : String(renames[snap.id] ?? '').trim()
      return { snap, originalNo, baleNo }
    })

    const clashes = []
    const seenNos = new Set()
    for (const one of plan) {
      // 包号留空 = 不占号，随便几个都能并存
      if (!one.baleNo) continue
      // 组内重名（两个源包被改成同一个号）：库里还没有这两行，查重查不到，自己看
      if (seenNos.has(one.baleNo)) {
        clashes.push({
          bale_id: one.snap.id,
          bale_no: one.baleNo,
          original_bale_no: one.originalNo,
          reason: 'duplicate',
        })
        continue
      }
      seenNos.add(one.baleNo)
      try {
        assertBaleNoAvailable(one.baleNo, { excludeBaleIds: newBaleIds })
      } catch (err) {
        if (err?.status !== 400) throw err
        clashes.push({
          bale_id: one.snap.id,
          bale_no: one.baleNo,
          original_bale_no: one.originalNo,
          reason: 'taken',
        })
      }
    }

    if (clashes.length > 0) {
      const names = clashes.map((one) => one.bale_no).join('、')
      const hasDuplicate = clashes.some((one) => one.reason === 'duplicate')
      const error = new Error(
        hasDuplicate
          ? `撤销失败：源包号 ${names} 里有重号，请给其中一个换一个包号再撤销`
          : `撤销失败：源包号 ${names} 已经被别的包用了，请换一个包号再撤销`,
      )
      error.status = 409
      error.code = 'BALE_NO_TAKEN'
      error.clashes = clashes
      throw error
    }

    // ① 新包从入库明细里扣掉
    for (const bale of newBales) detachBaleFromOrder(bale)
    // ② 删掉新包
    for (const bale of newBales) {
      db.prepare(`DELETE FROM bale_items WHERE bale_id = ?`).run(bale.id)
      db.prepare(`DELETE FROM bales WHERE id = ?`).run(bale.id)
    }

    /**
     * ③ 逐个源包原样重建：
     *    包号 / 条码号 / 柜号 / 提单 / 入库单 / 每一行的来源（src_inbound_order_id）都按快照回来。
     *
     *    包号查重放在**删完新包之后**：改包时允许把源包号给新包用（那时源包已被排除），
     *    提前查会把「自己拆出来的包」当成占位者，导致永远撤不回去。
     */
    const restored = plan.map(({ snap, baleNo }) => {
      const items = itemsFromSnapshot(
        Array.isArray(snap.items) && snap.items.length > 0 ? snap.items : fallbackItems,
      )

      /**
       * 条码号万一被别的包用了（含**软删**的包 —— 它进回收站后一恢复就会"复活"，
       * 让新包拿走同一个号就会变成两个活包同号），重新取一个，别撞号。
       */
      let restoredBarcode = snap.barcode
      const barcodeTaken = restoredBarcode
        ? db.prepare(`SELECT id FROM bales WHERE barcode = ?`).get(restoredBarcode)
        : null
      if (!restoredBarcode || barcodeTaken) {
        const shipment = snap.shipment_id ? blNoOfShipment.get(snap.shipment_id) : null
        const inboundOrder = snap.inbound_order_id
          ? orderBriefStmt.get(snap.inbound_order_id)
          : null
        restoredBarcode = takeBarcodes(1, {
          shipmentId: snap.shipment_id ?? null,
          shipmentNo: shipment?.bl_no ?? null,
          inboundOrderNo: inboundOrder?.order_no ?? null,
        })[0]
      }

      const bale = insertBaleWithItems({
        baleNo,
        barcode: restoredBarcode,
        boxNo: snap.box_no,
        shipmentId: snap.shipment_id,
        inboundOrderId: snap.inbound_order_id,
        items,
      })
      // ④ 挂回各自的入库明细（每行的 src 决定落哪张单）
      attachBaleToOrder(
        {
          id: bale.id,
          bale_no: bale.bale_no,
          box_no: snap.box_no ?? null,
          inbound_order_id: snap.inbound_order_id ?? null,
        },
        items,
      )
      return bale
    })

    db.prepare(`DELETE FROM repacks WHERE id = ?`).run(id)
    return {
      repack_no: row.repack_no,
      restored_bale: restored.map((one) => one.bale_no).join('、'),
      restored_bales: restored,
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

  /** 撤销时给源包改号：`{ renames: { [源包 id]: '新包号' } }`（可选） */
  const rawRenames = req.body?.renames
  const renames = {}
  if (rawRenames && typeof rawRenames === 'object') {
    for (const [key, value] of Object.entries(rawRenames)) {
      const baleId = Number(key)
      if (Number.isInteger(baleId) && baleId > 0) renames[baleId] = String(value ?? '').trim()
    }
  }

  try {
    res.json({ ok: true, ...removeRepack(id, { renames }) })
  } catch (err) {
    /** 源包号被占：把冲突清单一起带回去，前端就地让用户填新号 */
    if (err.status === 409) {
      return res.status(409).json({ error: err.message, code: err.code, clashes: err.clashes })
    }
    if (err.status === 400 || err.status === 404) {
      return res.status(err.status).json({ error: err.message })
    }
    res.status(500).json({ error: err.message })
  }
})

export default router
