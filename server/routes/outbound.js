import express from 'express'
import { db } from '../db.js'
import { calcCubic, calcAmountCents, toCents, fromCents } from '../utils/cubic.js'
import { calcCubicOfSpecs } from '../utils/cubic.js'
import { validateItems } from '../utils/validateItems.js'
import { expandSlashSpecs, specsOf } from '../utils/slashSpecs.js'
import { BALE_TEXT_COLS, baleItemsStmt, baleTextFields } from './bales.js'
import { pageParams } from '../utils/paging.js'
import { requireCap } from '../middleware/permissions.js'
import { keepPricesFrom, orderItemKey } from '../utils/keepPrices.js'

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
  // 解析不出来返回 NaN（而不是静默兜成 1），交给字段校验报中文错
  return toNumber(value, Number.NaN)
}

function normalizeItems(items) {
  return items.map((item) => {
    /**
     * 绑了码单的行：规格 / 片数以**这一包实际的 bale_items** 为准。
     *
     * 前端那一行显示的是这一包的原文 —— 混装包写的是斜杠串（`1.8/2.1/2.4`、`17/30/247`），
     * 直接 toNumber 会变成 0，校验就会报「长度必须大于 0m」，混装包永远发不出去。
     * 而真正要扣库存的规格本来就是按包里的段来的（见 specRowsOf / checkStock）。
     */
    const baleId = Number(item.bale_id) || null
    const baleItems = baleId ? baleItemsStmt.all(baleId) : []
    const head = baleItems[0] ?? null

    const spec = head
      ? {
          species: head.species,
          grade: head.grade,
          thickness: head.thickness,
          width: head.width,
          length: head.length,
        }
      : specOf(item)
    const pieces = head ? head.pieces : optionalNumber(item.pieces, 1)
    const bundles = optionalNumber(item.bundles, 1)
    // 混装包：出库明细也可能一行多段（长度 1800/2100/2400）；绑了码单就照包里的段来
    const specs = head
      ? baleItems.map((one) => ({ length: one.length, pieces: one.pieces }))
      : specsOf({ ...item, ...spec, pieces })
    const cubic = calcCubicOfSpecs(spec.thickness, spec.width, specs, bundles)
    // 金额一律走整数分，避免浮点累加误差；unit_price / amount 只是显示镜像
    const unitPriceCents = toCents(item.unit_price)
    const amountCents = calcAmountCents(cubic, unitPriceCents)

    return {
      ...spec,
      pieces,
      bundles,
      cubic,
      specs,
      /** 这一行明细是从哪一包带出来的（前端选的包）。做「明细 vs 包」一致性校验用 */
      bale_id: baleId,
      bale_no: item.bale_no ? String(item.bale_no) : '',
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

/**
 * 明细 vs 码单 的一致性校验（防「改完包数据不同步」再发生）。
 *
 * 背景：出库明细和 bales 是两套独立的数据，以前各写各的、互不校验。
 * 结果就是「这一包实际 55.35 立方，明细却按 9.15 扣了库存」也能存下去，
 * 剩下的 46 立方变成永远卖不掉的幽灵库存。
 *
 * 现在按包对账：明细里凡是标了 bale_id 的行，它们的立方合计必须等于这一包的立方
 * （±0.01 容差，容忍四舍五入）。混装包一包多行，合计照样对得上。
 */
function checkBaleCubic(items, baleIds) {
  const problems = []
  if (!Array.isArray(baleIds) || baleIds.length === 0) return problems

  const writtenByBale = new Map()
  for (const item of items) {
    const id = Number(item.bale_id)
    if (!Number.isInteger(id) || id <= 0) continue
    writtenByBale.set(id, (writtenByBale.get(id) ?? 0) + Number(item.cubic ?? 0))
  }

  const findBale = db.prepare(
    `SELECT bale_no, barcode, cubic FROM bales WHERE id = ? AND deleted_at IS NULL`,
  )

  for (const id of baleIds) {
    const written = writtenByBale.get(id)
    // 明细没标 bale_id（老前端 / 手工行）：这一包不参与对账，别误伤
    if (written === undefined) continue

    const bale = findBale.get(id)
    if (!bale) continue

    const real = roundTo(bale.cubic ?? 0, 4)
    const mine = roundTo(written, 4)
    if (Math.abs(real - mine) > 0.01) {
      problems.push(
        `这一包（${bale.bale_no || bale.barcode}）实际 ${real} 立方，明细只写了 ${mine}，请重新选择`,
      )
    }
  }

  return problems
}

/**
 * 把一条出库明细展开成「按规格的真实扣减行」。
 *
 * 界面上一包一行（长度片数是斜杠串），但库存按规格汇总，
 * 所以校验和落库都必须先展开成一段一行，两边共用这一份，口径不会跑偏。
 */
function* specRowsOf(item) {
  if (item.bale_id) {
    const rows = baleItemsStmt.all(item.bale_id)
    if (rows.length > 0) {
      for (const one of rows) {
        yield {
          species: one.species,
          grade: one.grade,
          thickness: one.thickness,
          width: one.width,
          length: one.length,
          pieces: one.pieces,
          bundles: item.bundles,
          cubic: calcCubic(one.thickness, one.width, one.length, one.pieces, item.bundles),
          unit_price_cents: Number(one.unit_price_cents ?? item.unit_price_cents ?? 0),
        }
      }
      return
    }
  }

  for (const spec of item.specs ?? [{ length: item.length, pieces: item.pieces }]) {
    yield {
      species: item.species,
      grade: item.grade,
      thickness: item.thickness,
      width: item.width,
      length: spec.length,
      pieces: spec.pieces,
      bundles: item.bundles,
      cubic: calcCubic(item.thickness, item.width, spec.length, spec.pieces, item.bundles),
      unit_price_cents: spec.cents ?? item.unit_price_cents ?? 0,
    }
  }
}

function checkStock(items) {
  const groups = new Map()

  for (const item of items) {
    // 按规格展开后再比库存：混装包一包多段，挤成一行会算出「长3 却有 2080 片」这种假规格
    for (const row of specRowsOf(item)) {
      const key = specKey(row)
      const group = groups.get(key) ?? {
        species: row.species,
        grade: row.grade,
        thickness: row.thickness,
        width: row.width,
        length: row.length,
        cubic: 0,
        bundles: 0,
      }
      group.cubic += row.cubic
      group.bundles += row.bundles
      groups.set(key, group)
    }
  }

  return compareWithStock(groups)
}

function compareWithStock(groups) {
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

/**
 * 一条出库明细 → 落几行 order_items。
 *
 * 界面上一包只显示 **1 行**（长度/片数写斜杠串），但库存是按「品名+等级+规格」
 * 分别汇总的，所以落库时得按这一包的规格段拆成多行，否则混装包里
 * 除第一段之外的库存都扣不到。
 *
 * - 绑了码单（item.bale_id 有值）→ 从这一包的 bale_items 取段，按段落多行
 * - 手工行（没有 bale_id）→ 按 item.specs 或单段落一行
 */
function insertItemRows(stmt, item, orderId) {
  // 和库存校验共用同一份展开（specRowsOf），保证「校验用哪几行」和「落库哪几行」完全一致
  for (const row of specRowsOf(item)) {
    const amountCents = calcAmountCents(row.cubic, row.unit_price_cents)
    stmt.run({
      ...item,
      order_id: orderId,
      length: row.length,
      pieces: row.pieces,
      cubic: row.cubic,
      unit_price_cents: row.unit_price_cents,
      unit_price: fromCents(row.unit_price_cents),
      amount: fromCents(amountCents),
      amount_cents: amountCents,
    })
  }
}

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
    // 混装包一行多段 → 每段单独落一条明细，库存才按规格扣得对
    for (const item of items) {
      insertItemRows(insertItem, item, orderId)
    }

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
router.post('/', requireCap('outbound.write'), (req, res) => {
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
  // 出库一定要指明发的是哪几包：不然库存减了、包还是「在库」，两边对不上
  if (rawBales.length === 0) {
    return res.status(400).json({ error: '请先选择要出库的码单（包）' })
  }

  // 码单校验：必须都是「在库」状态，别人发过的包不能再发一次
  const baleErrors = checkBales(rawBales)
  if (baleErrors.length > 0) {
    return res.status(400).json({ error: baleErrors.join('\n') })
  }

  // 混装包：出库明细也支持「长度 1800/2100/2400 + 片数 17/30/247」
  const expanded = expandSlashSpecs(rawItems)
  if (expanded.problems.length > 0) {
    return res.status(400).json({ error: expanded.problems.join('\n') })
  }
  const items = normalizeItems(expanded.items)
  // 字段级校验：出库额外要求该行立方大于 0（库存校验在事务里，逻辑未改动）
  const problems = validateItems(items, { requirePositiveCubic: true })
  if (problems.length > 0) {
    return res.status(400).json({ error: problems.join('\n') })
  }

  // 明细和「发走的包」必须对得上（见 checkBaleCubic 里的说明）
  const baleProblems = checkBaleCubic(items, rawBales)
  if (baleProblems.length > 0) {
    return res.status(400).json({ error: baleProblems.join('\n') })
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

/* ---------- 扫码出库：解析标签上的二维码 ---------- */

/**
 * 标签上的二维码内容：MZ|码单号|包号
 *   码单号 = 条码号（bales.barcode，例如 BL-REG-001-001）
 *   包号   = bales.bale_no（例如 P1）
 * 扫到码以后交给前端追加到出库明细，规格、立方、成本价都由这里算好返回。
 */
const findBaleByBarcodeStmt = db.prepare(
  `SELECT * FROM bales WHERE barcode = ? AND deleted_at IS NULL`,
)
const baleItemsOfStmt = db.prepare(
  `SELECT * FROM bale_items WHERE bale_id = ? ORDER BY id`,
)
/** 规格行对应的入库单价（分）：按「品名+等级+规格+片数」到这张入库单的明细里找 */
const itemPriceStmt = db.prepare(
  `SELECT COALESCE(unit_price_cents, ROUND(unit_price * 100)) AS cents
     FROM order_items
    WHERE order_type = 'in' AND order_id = ? AND deleted_at IS NULL
      AND COALESCE(species, '') = COALESCE(?, '')
      AND COALESCE(grade, '')   = COALESCE(?, '')
      AND thickness = ? AND width = ? AND length = ? AND pieces = ?
    ORDER BY id
    LIMIT 1`,
)

/** 这一包的成本价（加权平均 = Σ(立方×单价) ÷ Σ立方），取不到就是 null */
function baleCostPrice(bale) {
  if (!bale.inbound_order_id) return null
  const items = baleItemsOfStmt.all(bale.id)
  const cubic = items.reduce((sum, item) => sum + (item.cubic ?? 0), 0)
  if (cubic <= 0) return null
  const amountCents = items.reduce((sum, item) => {
    const cents = Number(
      itemPriceStmt.get(
        bale.inbound_order_id,
        item.species,
        item.grade,
        item.thickness,
        item.width,
        item.length,
        item.pieces,
      )?.cents ?? 0,
    )
    return sum + Math.round((item.cubic ?? 0) * cents)
  }, 0)
  const price = fromCents(Math.round(amountCents / cubic))
  return price > 0 ? price : null
}

router.get('/scan', (req, res) => {
  const code = String(req.query.code ?? '').trim()
  const parts = code.split('|')
  // 不是「MZ|码单号|包号」这种格式的，直接告诉用户不是本系统的码
  if (parts.length !== 3 || parts[0] !== 'MZ') {
    return res.status(400).json({ error: '不是本系统的码' })
  }

  const [, barcode, baleNo] = parts
  const bale = findBaleByBarcodeStmt.get(barcode)
  if (!bale) {
    return res.status(404).json({ error: '未找到该码对应的包' })
  }
  if (baleNo && bale.bale_no && baleNo !== bale.bale_no) {
    return res.status(404).json({ error: '未找到该码对应的包' })
  }
  if (bale.status !== 'in_stock') {
    return res.status(400).json({ error: '这一包已经出库了' })
  }

  /**
   * 规格行单独给出来：混装包一包里有几段不同长度，
   * 前端要按**每一段**生成一行出库明细（不是拿主规格拼一行），
   * 否则立方会算错 —— 这正是「改完包数据不同步」那个 bug 的根源。
   */
  const items = baleItemsOfStmt.all(bale.id).map((item) => ({
    brand: item.brand ?? '',
    species: item.species ?? '',
    grade: item.grade ?? '',
    thickness: item.thickness,
    width: item.width,
    length: item.length,
    pieces: item.pieces,
    cubic: roundTo(item.cubic ?? 0, 4),
    unit_price: fromCents(Number(item.unit_price_cents ?? 0)),
  }))

  res.json({
    bale_id: bale.id,
    bale_no: bale.bale_no ?? '',
    barcode: bale.barcode ?? '',
    box_no: bale.box_no ?? '',
    species: bale.species ?? '',
    grade: bale.grade ?? '',
    thickness: bale.thickness,
    width: bale.width,
    length: bale.length,
    pieces: bale.pieces ?? 0,
    bundles: 1,
    cubic: roundTo(bale.cubic ?? 0, 4),
    unit_price: baleCostPrice(bale),
    is_mixed: items.length > 1,
    items,
  })
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
    insertItemRows(insertItem, item, id)
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
router.put('/:id', requireCap('outbound.write'), (req, res) => {
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

  /** 同入库：看不到金额的角色编辑出库单时，把没填单价的行按原行原价补齐 */
  const oldItems = db
    .prepare(
      `SELECT * FROM order_items
        WHERE order_type = 'out' AND order_id = ? AND deleted_at IS NULL
        ORDER BY id`,
    )
    .all(id)

  // 先拆斜杠、再补原价：展开之后 length/pieces 才是数字，才能和原明细对上号
  const expanded = expandSlashSpecs(rawItems)
  if (expanded.problems.length > 0) {
    return res.status(400).json({ error: expanded.problems.join('\n') })
  }
  const items = normalizeItems(
    keepPricesFrom(expanded.items, oldItems, {
      keyOf: orderItemKey,
      priceOf: (row) => Number(row.unit_price_cents ?? Math.round((row.unit_price ?? 0) * 100)),
    }),
  )
  const problems = validateItems(items, { requirePositiveCubic: true })
  if (problems.length > 0) {
    return res.status(400).json({ error: problems.join('\n') })
  }

  // 明细和「这张单已经发走的包」必须对得上（编辑时不重绑包，所以查库里挂着的那几包）
  const shippedBaleIds = db
    .prepare(`SELECT id FROM bales WHERE outbound_order_id = ? AND deleted_at IS NULL`)
    .all(id)
    .map((row) => row.id)
  const baleProblems = checkBaleCubic(items, shippedBaleIds)
  if (baleProblems.length > 0) {
    return res.status(400).json({ error: baleProblems.join('\n') })
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
              b.thickness, b.width, b.length,
              ${BALE_TEXT_COLS},
              s.bl_no, s.contract_no
         FROM bales b
         LEFT JOIN shipments s ON s.id = b.shipment_id
        WHERE b.outbound_order_id = ?
        ORDER BY b.bale_no`,
    )
    .all(id)
    .map((row) => ({
      bale_no: row.bale_no,
      barcode: row.barcode ?? row.bale_no ?? '',
      cubic: roundTo(row.cubic ?? 0, 4),
      pieces: row.pieces ?? 0,
      // 厚 / 宽 永远单值；长度和片数混装时才是斜杠串
      thickness: row.thickness,
      width: row.width,
      length: row.length,
      // 混装包：长度 / 片数用斜杠串，别拿「第一段 + 片数合计」糊弄（和 /api/bales 一个口径）
      ...baleTextFields(row),
      status: row.status,
      bl_no: row.bl_no ?? '',
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

/*
 * 撤销出库：发走的码单要退回在库，货才算回到库里。
 *
 * ⚠️ 这里**故意不清空 outbound_order_id**：
 * 清空之后「这张出库单当初发走了哪几包」就没有任何记录了，从回收站恢复这张单时
 * 包回不到「已出库」—— 库存数字扣回去了，包却还是「在库」，两边对不上
 * （还能被再发一次，重扣一遍）。指针留着，状态才是唯一口径：
 * 在库 = status='in_stock'（列表里的「出库单号」也只在 shipped 行显示）。
 * 撤销 / 恢复是对称的两步，见 recycle.js 的恢复分支。
 */
const releaseBalesStmt = db.prepare(
  `UPDATE bales
      SET status = 'in_stock', shipped_at = NULL
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
router.delete('/:id', requireCap('outbound.write'), (req, res) => {
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
