import express from 'express'
import { db } from '../db.js'
import { calcCubic, calcAmountCents, toCents, fromCents } from '../utils/cubic.js'

const router = express.Router()

const roundTo = (value, digits) => Number((value ?? 0).toFixed(digits))

const MAX_THICKNESS = 1000 // mm
const MAX_WIDTH = 1000 // mm
const MAX_LENGTH = 20 // m

/** 本地日期 YYYY-MM-DD */
function todayLocal() {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * 单号规则：前缀 + YYYYMMDD + 4 位流水（按同前缀最大值加一）
 * 盘点单 PD、盘盈 PY、盘亏 PK，和手工录入的 RK / CK 互不干扰
 */
function nextNo(table, column, prefix, date) {
  const head = `${prefix}${(date || todayLocal()).replace(/-/g, '')}`
  const last = db
    .prepare(
      `SELECT ${column} AS no FROM ${table}
        WHERE ${column} LIKE ?
        ORDER BY ${column} DESC
        LIMIT 1`,
    )
    .get(`${head}%`)

  const next = last ? Number(last.no.slice(head.length)) + 1 : 1
  return `${head}${String(next).padStart(4, '0')}`
}

/** 某规格当前账面：立方 / 件数 / 总片数（入库合计 - 出库合计） */
const specStockStmt = db.prepare(
  `SELECT COALESCE(SUM(CASE WHEN order_type = 'in' THEN cubic   ELSE -cubic   END), 0) AS cubic,
          COALESCE(SUM(CASE WHEN order_type = 'in' THEN bundles ELSE -bundles END), 0) AS bundles,
          COALESCE(SUM(CASE WHEN order_type = 'in'
                            THEN pieces * bundles
                            ELSE -pieces * bundles END), 0) AS pieces
     FROM order_items
    WHERE COALESCE(species, '') = ?
      AND COALESCE(grade, '')   = ?
      AND thickness = ?
      AND width     = ?
      AND length    = ?`,
)

/** 该规格最近一次入库单价（分），给盘盈盘亏估值用 */
const lastPriceStmt = db.prepare(
  `SELECT COALESCE(unit_price_cents, ROUND(unit_price * 100)) AS cents
     FROM order_items
    WHERE order_type = 'in'
      AND COALESCE(species, '') = ?
      AND COALESCE(grade, '')   = ?
      AND thickness = ?
      AND width     = ?
      AND length    = ?
    ORDER BY id DESC
    LIMIT 1`,
)

/* ---------- 写入语句 ---------- */

const insertCount = db.prepare(
  `INSERT INTO stock_counts
     (count_no, count_date, remark, item_count, diff_cubic, in_order_no, out_order_no)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
)

const insertCountItem = db.prepare(
  `INSERT INTO stock_count_items
     (count_id, species, grade, thickness, width, length, pieces,
      book_bundles, book_cubic, actual_bundles, diff_bundles, diff_cubic,
      unit_price, unit_price_cents)
   VALUES
     (@count_id, @species, @grade, @thickness, @width, @length, @pieces,
      @book_bundles, @book_cubic, @actual_bundles, @diff_bundles, @diff_cubic,
      @unit_price, @unit_price_cents)`,
)

const insertInboundOrder = db.prepare(
  `INSERT INTO inbound_orders (order_no, supplier, order_date, remark)
   VALUES (?, ?, ?, ?)`,
)

const insertOutboundOrder = db.prepare(
  `INSERT INTO outbound_orders (order_no, customer, order_date, remark)
   VALUES (?, ?, ?, ?)`,
)

const insertAdjustItem = db.prepare(
  `INSERT INTO order_items
     (order_id, order_type, species, grade, thickness, width, length,
      pieces, bundles, cubic, unit_price, amount, unit_price_cents, amount_cents)
   VALUES
     (@order_id, @order_type, @species, @grade, @thickness, @width, @length,
      @pieces, @bundles, @cubic, @unit_price, @amount, @unit_price_cents, @amount_cents)`,
)

/**
 * 盘盈的一条明细 → 入库单明细；盘亏 → 出库单明细
 * 立方按「差异件数 × 每件立方」算，和手工出入库用的是同一套公式
 */
function buildAdjustItem(line, orderType) {
  const bundles = Math.abs(line.diff_bundles)
  const cubic = calcCubic(
    line.thickness,
    line.width,
    line.length,
    line.pieces,
    bundles,
  )
  const amountCents = calcAmountCents(cubic, line.unit_price_cents)

  return {
    order_type: orderType,
    species: line.species,
    grade: line.grade,
    thickness: line.thickness,
    width: line.width,
    length: line.length,
    pieces: line.pieces,
    bundles,
    cubic,
    unit_price: fromCents(line.unit_price_cents),
    amount: fromCents(amountCents),
    unit_price_cents: line.unit_price_cents,
    amount_cents: amountCents,
  }
}

/**
 * 事务：盘点单 + 明细留档，并按差异生成盘盈入库单 / 盘亏出库单
 * 盘亏不会超卖：实盘件数 >= 0，所以调整后的库存就是实盘数，天然非负
 */
const createCount = db.transaction(({ countDate, remark, lines }) => {
  const countNo = nextNo('stock_counts', 'count_no', 'PD', countDate)
  const gains = lines.filter((line) => line.diff_bundles > 0)
  const losses = lines.filter((line) => line.diff_bundles < 0)

  const inOrderNo = gains.length > 0 ? nextNo('inbound_orders', 'order_no', 'PY', countDate) : null
  const outOrderNo = losses.length > 0 ? nextNo('outbound_orders', 'order_no', 'PK', countDate) : null
  const diffCubic = roundTo(
    lines.reduce((sum, line) => sum + line.diff_cubic, 0),
    4,
  )

  const { lastInsertRowid } = insertCount.run(
    countNo,
    countDate,
    remark || null,
    lines.length,
    diffCubic,
    inOrderNo,
    outOrderNo,
  )
  const countId = Number(lastInsertRowid)

  for (const line of lines) {
    insertCountItem.run({ ...line, count_id: countId })
  }

  if (inOrderNo) {
    const { lastInsertRowid: inboundId } = insertInboundOrder.run(
      inOrderNo,
      '盘点调整',
      countDate,
      `盘点单 ${countNo}`,
    )
    for (const line of gains) {
      insertAdjustItem.run({ ...buildAdjustItem(line, 'in'), order_id: Number(inboundId) })
    }
  }

  if (outOrderNo) {
    const { lastInsertRowid: outboundId } = insertOutboundOrder.run(
      outOrderNo,
      '盘点调整',
      countDate,
      `盘点单 ${countNo}`,
    )
    for (const line of losses) {
      insertAdjustItem.run({ ...buildAdjustItem(line, 'out'), order_id: Number(outboundId) })
    }
  }

  return {
    id: countId,
    count_no: countNo,
    item_count: lines.length,
    diff_cubic: diffCubic,
    in_order_no: inOrderNo,
    out_order_no: outOrderNo,
  }
})

/* ---------- 新增盘点单 ---------- */

router.post('/', (req, res) => {
  const body = req.body ?? {}
  const countDate = body.count_date ? String(body.count_date) : todayLocal()
  const remark = body.remark ? String(body.remark) : ''
  const rawItems = Array.isArray(body.items) ? body.items : []

  if (rawItems.length === 0) {
    return res.status(400).json({ error: '至少需要一行盘点明细' })
  }

  const problems = []
  const lines = []

  rawItems.forEach((raw, index) => {
    const species = String(raw.species ?? '').trim()
    const grade = String(raw.grade ?? '').trim()
    const thickness = Number(raw.thickness)
    const width = Number(raw.width)
    const length = Number(raw.length)
    const actualBundles = Number(raw.actual_bundles)

    const reasons = []
    if (!species) reasons.push('品名不能为空')
    if (!(thickness > 0 && thickness <= MAX_THICKNESS)) {
      reasons.push(`厚度必须在 0 ~ ${MAX_THICKNESS}mm 之间`)
    }
    if (!(width > 0 && width <= MAX_WIDTH)) {
      reasons.push(`宽度必须在 0 ~ ${MAX_WIDTH}mm 之间`)
    }
    if (!(length > 0 && length <= MAX_LENGTH)) {
      reasons.push(`长度必须在 0 ~ ${MAX_LENGTH}m 之间`)
    }
    if (!(Number.isInteger(actualBundles) && actualBundles >= 0)) {
      reasons.push('实盘件数必须是大于等于 0 的整数')
    }

    const rawPieces = raw.pieces
    const piecesInput =
      rawPieces === undefined || rawPieces === null || String(rawPieces).trim() === ''
        ? null
        : Number(rawPieces)
    if (piecesInput !== null && !(Number.isInteger(piecesInput) && piecesInput > 0)) {
      reasons.push('每件片数必须是大于 0 的整数')
    }

    if (reasons.length > 0) {
      problems.push(`第 ${index + 1} 行：${reasons.join('；')}`)
      return
    }

    // 账面数：实时从出入库明细汇总，不依赖前端传来
    const book = specStockStmt.get(species, grade, thickness, width, length)
    const bookBundles = Math.round(Number(book?.bundles ?? 0))
    const bookCubic = roundTo(book?.cubic ?? 0, 4)

    const piecesPerBundle =
      piecesInput ??
      (bookBundles > 0
        ? Math.max(1, Math.round(Number(book?.pieces ?? 0) / bookBundles))
        : 1)

    const diffBundles = actualBundles - bookBundles
    // 差异立方按「差异件数 × 每件立方」算，与手工出入库同一套公式
    const diffCubic =
      diffBundles === 0
        ? 0
        : Number(
            (
              Math.sign(diffBundles) *
              calcCubic(thickness, width, length, piecesPerBundle, Math.abs(diffBundles))
            ).toFixed(4),
          )

    const rawPrice = raw.unit_price
    const priceInput =
      rawPrice === undefined || rawPrice === null || String(rawPrice).trim() === ''
        ? null
        : toCents(rawPrice)
    if (priceInput !== null && priceInput < 0) {
      problems.push(`第 ${index + 1} 行：单价不能为负数`)
      return
    }

    const unitPriceCents =
      priceInput ?? Number(lastPriceStmt.get(species, grade, thickness, width, length)?.cents ?? 0)

    lines.push({
      species,
      grade,
      thickness,
      width,
      length,
      pieces: piecesPerBundle,
      book_bundles: bookBundles,
      book_cubic: bookCubic,
      actual_bundles: actualBundles,
      diff_bundles: diffBundles,
      diff_cubic: diffCubic,
      unit_price: fromCents(unitPriceCents),
      unit_price_cents: unitPriceCents,
    })
  })

  if (problems.length > 0) {
    return res.status(400).json({ error: problems.join('\n') })
  }

  try {
    res.json(createCount({ countDate, remark, lines }))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/* ---------- 盘点单列表 ---------- */

router.get('/', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, count_no, count_date, remark, item_count, diff_cubic,
              in_order_no, out_order_no, created_at
         FROM stock_counts
        ORDER BY id DESC`,
    )
    .all()

  res.json(rows)
})

/* ---------- 盘点单详情 ---------- */

router.get('/:id', (req, res) => {
  const id = Number(req.params.id)
  const head = db.prepare(`SELECT * FROM stock_counts WHERE id = ?`).get(id)

  if (!head) {
    return res.status(404).json({ error: '盘点单不存在' })
  }

  const items = db
    .prepare(
      `SELECT * FROM stock_count_items
        WHERE count_id = ?
        ORDER BY id`,
    )
    .all(id)

  res.json({ ...head, items })
})

/* ---------- 删除盘点单 ---------- */

const getCountStmt = db.prepare(`SELECT * FROM stock_counts WHERE id = ?`)
const countLinesStmt = db.prepare(
  `SELECT species, grade, thickness, width, length, diff_bundles
     FROM stock_count_items
    WHERE count_id = ?`,
)
const findInboundStmt = db.prepare(`SELECT id FROM inbound_orders WHERE order_no = ?`)
const findOutboundStmt = db.prepare(`SELECT id FROM outbound_orders WHERE order_no = ?`)
const adjustItemsStmt = db.prepare(
  `SELECT species, grade, thickness, width, length, cubic, bundles
     FROM order_items
    WHERE order_type = ? AND order_id = ?`,
)
const deleteAdjustItemsStmt = db.prepare(
  `DELETE FROM order_items WHERE order_type = ? AND order_id = ?`,
)
const deleteInboundStmt = db.prepare(`DELETE FROM inbound_orders WHERE id = ?`)
const deleteOutboundStmt = db.prepare(`DELETE FROM outbound_orders WHERE id = ?`)
const deleteCountLinesStmt = db.prepare(`DELETE FROM stock_count_items WHERE count_id = ?`)
const deleteCountStmt = db.prepare(`DELETE FROM stock_counts WHERE id = ?`)

/**
 * 事务：撤销盘点单，连带删掉它生成的盘盈入库单 / 盘亏出库单。
 *
 * 顺序很关键：先删盘亏（出库）那一侧，库存只会涨、永远安全；再删盘盈（入库）那一侧，
 * 这时才需要确认「删完库存不会变负」——和入库单删除用的是同一套判断和同一句提示。
 * 任何一步不通过都会整体回滚，不会留下半截单子。
 */
const removeCount = db.transaction((id) => {
  const head = getCountStmt.get(id)
  if (!head) {
    const error = new Error('盘点单不存在')
    error.status = 404
    throw error
  }

  const inboundId = head.in_order_no ? findInboundStmt.get(head.in_order_no)?.id : null
  const outboundId = head.out_order_no ? findOutboundStmt.get(head.out_order_no)?.id : null

  if (outboundId) {
    deleteAdjustItemsStmt.run('out', outboundId)
    deleteOutboundStmt.run(outboundId)
  }

  if (inboundId) {
    // 同规格的多行先合并
    const groups = new Map()
    for (const item of adjustItemsStmt.all('in', inboundId)) {
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
      const stock = specStockStmt.get(
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
            `撤销盘盈后会变成 ${afterCubic} 立方 / ${afterBundles} 件，库存不能为负`,
        )
      }
    }

    if (problems.length > 0) {
      const error = new Error(problems.join('\n'))
      error.status = 400
      throw error
    }

    deleteAdjustItemsStmt.run('in', inboundId)
    deleteInboundStmt.run(inboundId)
  }

  deleteCountLinesStmt.run(id)
  deleteCountStmt.run(id)

  return head
})

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '盘点单 ID 不合法' })
  }

  try {
    removeCount(id)
    res.json({ ok: true })
  } catch (err) {
    if (err.status === 400 || err.status === 404) {
      return res.status(err.status).json({ error: err.message })
    }
    res.status(500).json({ error: err.message })
  }
})

export default router
