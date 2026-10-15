import express from 'express'
import { db } from '../db.js'
import { calcCubic } from '../utils/cubic.js'
import { pageParams } from '../utils/paging.js'
import { calcAmountCents, fromCents, toCents } from '../utils/cubic.js'
import { writeLog } from '../boot-log.js'
import { requireCap } from '../middleware/permissions.js'
import { expandSlashSpecs, specsOf, toMeters } from '../utils/slashSpecs.js'

const router = express.Router()

const roundTo = (value, digits) => Number((value ?? 0).toFixed(digits))

/**
 * 码单列表：一包一条，带上柜号 / 合同号 / 出库单号，
 * 用来查「这包货还在不在、卖给了谁、属于哪个合同」。
 *
 * 下面这三段子查询是**混装包的显示口径**，全项目共用（列表 / 详情 / 改包选货）：
 * `bales` 表只存得下「第一条规格」的厚宽长 + 全部规格的片数合计，
 * 直接拿来显示必然是错的（长度只有第一段、片数却是几段之和）。
 * 所以从 bale_items 拼出斜杠串：
 *   长度 1.8/2.1/2.4   片数 17/30/247   规格 33×22×1.8/2.1/2.4
 *
 * ⚠️ GROUP_CONCAT 官方不保证顺序，必须套一层带 ORDER BY id 的子查询，
 *    否则会出现 2.1/1.8/2.4 这种乱序。
 */
export const BALE_TEXT_COLS = `
  (SELECT GROUP_CONCAT(t.length, '/') FROM
     (SELECT length FROM bale_items WHERE bale_id = b.id ORDER BY id) t) AS length_text,
  (SELECT GROUP_CONCAT(t.pieces, '/') FROM
     (SELECT pieces FROM bale_items WHERE bale_id = b.id ORDER BY id) t) AS pieces_text,
  (SELECT COUNT(*) FROM bale_items bi WHERE bi.bale_id = b.id) AS item_count
`

/**
 * 这一包里「属于它主单」的立方。
 *
 * 跨单合并出来的包只挂在**主单**下（`bales.inbound_order_id`），`b.cubic` 是整包合计；
 * 主单看这一包时得知道"其中多少是我的货"，否则会困惑「这包 8 方，我这单才 3 方」。
 *
 * ⚠️ 口径必须和入库单详情（routes/inbound.js 里那段 own_cubic）**逐字一致**：
 *    - 老数据没有来源标记 → 用 COALESCE 兜底按"算这一包的"归类，
 *      这样普通包算出来就等于整包立方，前端按"小于才显示 本单/总"处理。
 */
export const BALE_OWN_CUBIC_COL = `
  (SELECT ROUND(COALESCE(SUM(bi.cubic), 0), 4)
     FROM bale_items bi
    WHERE bi.bale_id = b.id
      AND COALESCE(bi.src_inbound_order_id, b.inbound_order_id) = b.inbound_order_id
  ) AS own_cubic
`

/**
 * 把上面那三列整理成给前端的字段。
 * `spec_text`：混装时是 `33×22×1.8/2.1/2.4`，单规格时退回原来的 `33×22×2`。
 */
export const baleTextFields = (row) => {
  const count = Number(row.item_count ?? 0)
  const mixed = count > 1
  const lengthText = row.length_text || String(row.length ?? '')
  const piecesText = row.pieces_text || String(row.pieces ?? '')
  return {
    length_text: lengthText,
    pieces_text: piecesText,
    is_mixed: mixed,
    spec_text: mixed
      ? `${row.thickness}×${row.width}×${lengthText}`
      : `${row.thickness}×${row.width}×${row.length}`,
  }
}

const listSql = (where) => `
  SELECT b.*,
         s.bl_no,
         s.contract_no,
         ${BALE_TEXT_COLS},
         ${BALE_OWN_CUBIC_COL},
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
            OR b.species LIKE ? OR b.grade LIKE ?
            OR s.bl_no LIKE ? OR s.contract_no LIKE ?)`,
    )
    params.push(keyword, keyword, keyword, keyword, keyword, keyword, keyword)
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

  /**
   * 精确按合同号筛（采购入库明细三层的第二层：点了合同但还没点提单时，
   * 下面要看的就是「这张合同下的所有包」）。
   *
   * 口径：这一包挂的**提单**属于这个合同 —— 和 L2 提单列表同源，
   * 三层（合同 → 提单 → 包）共用"提单的合同号"这一个键，不会出现
   * 「上面列了 3 张提单、下面却少几包」这种事。
   * 两边都 trim 再比（库里可能存着带空格的号）。
   * 子查询带上 `deleted_at IS NULL`：和 L2 只列活提单保持一致，
   * 免得出现「包在 L3 里、它挂的提单却不在 L2 里」。
   */
  const contractNo = String(req.query.contract_no ?? '').trim()
  if (contractNo) {
    conditions.push(
      `AND b.shipment_id IN (
         SELECT id FROM shipments
          WHERE TRIM(contract_no) = ? AND deleted_at IS NULL)`,
    )
    params.push(contractNo)
  }

  const species = like(req.query.species)
  if (species) {
    conditions.push(`AND b.species LIKE ?`)
    params.push(species)
  }

  // 改包选货要按仓库 / 入库日期筛：仓库和日期在入库单上
  const warehouse = like(req.query.warehouse)
  if (warehouse) {
    conditions.push(
      `AND b.inbound_order_id IN (SELECT id FROM inbound_orders WHERE warehouse LIKE ?)`,
    )
    params.push(warehouse)
  }
  if (req.query.date_from) {
    conditions.push(
      `AND b.inbound_order_id IN (SELECT id FROM inbound_orders WHERE order_date >= ?)`,
    )
    params.push(String(req.query.date_from))
  }
  if (req.query.date_to) {
    conditions.push(
      `AND b.inbound_order_id IN (SELECT id FROM inbound_orders WHERE order_date <= ?)`,
    )
    params.push(String(req.query.date_to))
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
      // 整包里属于**主单**的那部分（跨单合并包会小于 cubic）；口径同入库单详情
      own_cubic: roundTo(row.own_cubic ?? 0, 4),
      // 混装包：长度 / 片数用斜杠串，规格也是（见 BALE_TEXT_COLS 的说明）
      ...baleTextFields(row),
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
 * 这个提单号下，下一个该用的条码号流水。
 *
 * 三条规矩：
 *   1) 不能按 COUNT(*) 算 —— 删掉中间某包之后 COUNT 会变小，再生成的号会和在用的撞上。
 *      所以按「已有号里的最大流水 + 1」。
 *   2) **软删的包也要算进来** —— 所以这里**不带** `deleted_at IS NULL`。
 *      只数活包的话，删掉一包再入同一张提单的货，新包会拿到刚删掉的那个号 ——
 *      而老包是"软删"，回收站一恢复就变成两个活包同号（条码号没有唯一索引，静默重号），
 *      贴出去的标签、扫出来的码就串了。和入库单号（RK/CK）一个口径：删过的号不重用。
 *   3) **按"提单号"数，不按 `shipment_id` 数**。删掉最后一张入库单时提单会被软删，
 *      同一票货再入库会**新建一张同名提单**（新 id）—— 按 id 数就会从 001 重新开始，
 *      和那张软删提单里已经贴出去的标签撞号。统一按 bl_no（含软删的历史提单）数，
 *      这条流水才能跨"删了再建"保持连续。
 */
export function nextSequenceOfBlNo(blNo) {
  const key = String(blNo ?? '').trim()
  if (!key) return 1
  const rows = db
    .prepare(
      `SELECT b.barcode AS barcode
         FROM bales b
         JOIN shipments s ON s.id = b.shipment_id
        WHERE lower(trim(s.bl_no)) = lower(trim(?))`,
    )
    .all(key)
  return maxSequence(rows.map((row) => row.barcode)) + 1
}

const blNoOfShipmentStmt = db.prepare(`SELECT bl_no FROM shipments WHERE id = ?`)

export function nextBaleSequence(shipmentId, inboundOrderNo) {
  if (shipmentId) {
    const blNo = String(blNoOfShipmentStmt.get(shipmentId)?.bl_no ?? '').trim()
    if (blNo) return nextSequenceOfBlNo(blNo)
    // 查不到提单号（脏数据）就退回按这一张提单数，仍然算上软删的包
    const rows = db.prepare(`SELECT barcode FROM bales WHERE shipment_id = ?`).all(shipmentId)
    return maxSequence(rows.map((row) => row.barcode)) + 1
  }

  const rows = db
    .prepare(
      `SELECT barcode FROM bales
        WHERE shipment_id IS NULL AND inbound_order_id IN
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
  /*
   * next_seq 必须和 nextBaleSequence 同一口径（按提单号数、算上软删的包），
   * 否则表单上提示"下一个 X-001"，真保存下去却拿到 X-002。
   * count / box_count 仍只看活包 —— 它们回答的是"这张提单现在贴着几张码单"。
   */
  const blNo = String(blNoOfShipmentStmt.get(shipmentId)?.bl_no ?? '').trim()
  return {
    count: rows.length,
    box_count: boxes.size,
    next_seq: blNo ? nextSequenceOfBlNo(blNo) : maxSequence(rows.map((row) => row.barcode)) + 1,
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

/**
 * 包号唯一性校验：**全局唯一**（跨提单、跨柜、跨一切），空包号不参与。
 *
 * 规则（用户确认）：
 *   - 有值的包号，整个系统里只能出现一次
 *   - 空包号随便有几个，并存没问题
 *
 * 数据库那边有 idx_bales_no_global 兜底，这里提前拦是为了给出中文提示
 * （直接撞索引只会得到 `UNIQUE constraint failed`）。
 *
 * @param {string} baleNo 要用的包号
 * @param {{ excludeBaleId?: number, excludeBaleIds?: number[] }} [options]
 *   改包时排除"原包自己"：单包改传 excludeBaleId，多包合并/拆分传 excludeBaleIds
 *   （这几个包马上要被删掉，它们占着的号要允许新包继续用）
 */
export function assertBaleNoAvailable(baleNo, { excludeBaleId, excludeBaleIds } = {}) {
  const key = String(baleNo ?? '').trim()
  if (!key) return

  const hit = db
    .prepare(`SELECT id FROM bales WHERE bale_no = ? AND deleted_at IS NULL`)
    .get(key)
  if (!hit) return
  const excluded = new Set(
    [
      ...(Array.isArray(excludeBaleIds) ? excludeBaleIds : []),
      ...(excludeBaleId === undefined ? [] : [excludeBaleId]),
    ].map(Number),
  )
  if (excluded.has(Number(hit.id))) return

  const error = new Error(`包号 ${key} 已经存在，请换一个`)
  error.status = 400
  throw error
}

/** 包号查重：同一范围（提单 / 散货按入库单）里找同名包 —— 内部辅助用，不再做对外校验 */
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
      /**
       * 全局唯一。编辑这张单时，它自己原来的包要排除掉
       * （包号没改的话本来就在库里，不能算冲突）。
       */
      const hit = db
        .prepare(`SELECT id, inbound_order_id FROM bales WHERE bale_no = ? AND deleted_at IS NULL`)
        .get(key)
      const ownBale =
        hit && excludeOrderId && Number(hit.inbound_order_id) === Number(excludeOrderId)
      if (hit && !ownBale) {
        const error = new Error(`包号 ${key} 已经存在，请换一个`)
        error.status = 400
        throw error
      }
    }
  })
}
/**
 * 条码号查重：**软删的包也算用过**（所以不带 `deleted_at IS NULL`）。
 * 口径和 `nextSequenceOfBlNo` 一致：条码号是贴在实物上的，删单只是把它放进回收站，
 * 回收站一恢复这个号就会"复活"—— 让新包拿走它会变成两个活包同号。
 */
const findBaleByBarcode = db.prepare(`SELECT * FROM bales WHERE barcode = ?`)
const insertBaleItem = db.prepare(
  `INSERT INTO bale_items
     (bale_id, brand, species, grade, thickness, width, length, pieces, cubic, unit_price_cents,
      src_inbound_order_id)
   VALUES
     (@bale_id, @brand, @species, @grade, @thickness, @width, @length, @pieces, @cubic, @unit_price_cents,
      @src_inbound_order_id)`,
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
  /**
   * 这一包的规格段。普通行就是一段（长度/片数各一个数）；
   * 混装包一行写多段（长度 1800/2100/2400 + 片数 17/30/247），
   * 这几段落进**同一张码单**的多行规格行 —— 也就是「一包混装」。
   */
  specs,
  shipmentId,
  shipmentNo,
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

  const specList =
    Array.isArray(specs) && specs.length > 0
      ? specs
      : [{ length: item.length, pieces: item.pieces }]

  let sequence = nextBaleSequence(shipmentId, inboundOrderNo)
  /** 一件（一包）的立方：单段时就等于原来的算法 */
  const cubicPerBale = roundTo(
    specList.reduce(
      (sum, spec) =>
        sum + calcCubic(item.thickness, item.width, spec.length, spec.pieces, 1),
      0,
    ),
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

    const scopeKey = baleScopeKey(shipmentId, inboundOrderId)
    /**
     * 手填了包号：全局唯一校验（preflightBales 已经拦过一次，这里是兜底）。
     * 「同包再加一行」这个功能已经删掉 —— 混装包现在是一行写多段长度（斜杠），
     * 不再靠「往已有包里追加规格」拼出来，所以这里不存在「找到已有包」的分支。
     */
    if (label) assertBaleNoAvailable(label)

    const bale = (() => {
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
          // 包号留空就存空字符串 —— 不再拿条码号顶替（用户明确要求）
          label || '',
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
      return { id: Number(lastInsertRowid), bale_no: label || '', barcode }
    })()
    created.push(bale)

    // 规格行：一包可以有几段（混装包就是在这里落成多行的）
    for (const spec of specList) {
      insertBaleItem.run({
        bale_id: bale.id,
        brand: item.brand ?? null,
        species: item.species,
        grade: item.grade,
        thickness: item.thickness,
        width: item.width,
        length: spec.length,
        pieces: spec.pieces,
        cubic: roundTo(calcCubic(item.thickness, item.width, spec.length, spec.pieces, 1), 4),
        unit_price_cents: item.unit_price_cents ?? null,
        // 这一行来自哪张入库单：入库时就是这张单
        src_inbound_order_id: inboundOrderId ?? null,
      })
    }

    /**
     * 规格行写完再重算一次汇总。
     * 以前的版本只在「填了包号」时才算，靠新建 bale 时写进去的单段立方兜底；
     * 混装包一包多段，必须每次都算，否则包里只认第一段。
     */
    refreshBaleSummary(bale.id)
  }

  return created
}

/* ---------- 码单编辑 / 删除：库存口径在入库单明细上，必须同步 ---------- */

// 带上斜杠串那几列：详情接口和内部取包都用它，口径和列表完全一致
const getBaleStmt = db.prepare(
  `SELECT b.*, ${BALE_TEXT_COLS} FROM bales b WHERE b.id = ? AND b.deleted_at IS NULL`,
)
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
/**
 * 从这一行的包号列表里摘掉「已经拆出去的那一包」。
 *
 * 为什么必须摘：改包/删码单是「原明细行扣 1 件 + 新增一行」。
 * 如果原行的 bale_no 还留着被拆走的包号（比如原来写「P1、P2」，拆走 P1 后还剩 1 件），
 * 编辑入库单时这一批里就会出现两个 P1（原行 + 新增行），整单存不回去。
 */
function stripBaleNo(baleNo, detached) {
  const labels = String(baleNo ?? '')
    .split(/[、,，\s]+/)
    .map((one) => one.trim())
    .filter(Boolean)
  if (!detached) return labels.join('、') || null
  const rest = labels.filter((one) => one !== detached)
  return rest.join('、') || null
}

function removeOneBundleFromOrder(orderId, item, detachedBaleNo) {
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
        SET bundles = ?, cubic = ?, amount = ?, amount_cents = ?, bale_no = ?
      WHERE id = ?`,
  ).run(
    bundles,
    cubic,
    fromCents(amountCents),
    amountCents,
    stripBaleNo(row.bale_no, detachedBaleNo),
    row.id,
  )
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
       (order_id, order_type, brand, species, grade, thickness, width, length,
        box_no, bale_no,
        pieces, bundles, cubic, unit_price, amount, unit_price_cents, amount_cents)
     VALUES
       (?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  ).run(
    orderId,
    item.brand ?? null,
    item.species,
    item.grade,
    item.thickness,
    item.width,
    item.length,
    item.box_no ?? null,
    item.bale_no ?? null,
    item.pieces,
    cubic,
    fromCents(priceCents),
    fromCents(amountCents),
    priceCents,
    amountCents,
  )
}

/**
 * 这一行规格属于哪张入库单。
 * 优先看行自己记的来源（`bale_items.src_inbound_order_id`），
 * 老数据没这一列/为空时退回「这一包挂的那张单」。
 */
const orderIdOfLine = (item, bale) =>
  Number(item?.src_inbound_order_id ?? bale?.inbound_order_id ?? 0) || null

/** 把行按来源单分组：一包里可能混了好几张单的货，账要各扣各的 */
function groupBySourceOrder(items, bale) {
  const groups = new Map()
  for (const item of items) {
    const orderId = orderIdOfLine(item, bale)
    if (!orderId) continue
    if (!groups.has(orderId)) groups.set(orderId, [])
    groups.get(orderId).push(item)
  }
  return groups
}

/** 把码单的旧规格行从各自的入库单里整体扣掉 */
export function detachBaleFromOrder(bale) {
  if (!bale) return
  for (const [orderId, items] of groupBySourceOrder(baleItemsStmt.all(bale.id), bale)) {
    for (const item of items) {
      // 把这一包的包号一起带进去：扣件时要从原行的包号列表里摘掉它
      removeOneBundleFromOrder(orderId, item, bale.bale_no)
    }
  }
}

/** 把码单的新规格行挂回**各自**的入库单 */
export function attachBaleToOrder(bale, items) {
  if (!bale) return
  for (const [orderId, group] of groupBySourceOrder(items, bale)) {
    for (const item of group) {
      /**
       * 包号 / 柜号是包级字段：挂回去的明细行必须知道自己是哪一包的，
       * 否则「采购入库明细」里这几行的包号会变成空 —— 拆包之后尤其明显。
       */
      addOneBundleToOrder(orderId, {
        ...item,
        bale_no: item.bale_no ?? bale.bale_no ?? null,
        box_no: item.box_no ?? bale.box_no ?? null,
      })
    }
  }
}

/**
 * 连续取 n 个没人用过的条码号。
 *
 * 「没人用过」= 不在 bales 里。注意要在**删除原包之前**调用：
 * 拆包时原包马上要被删掉，如果先删再取号，而原包正好是这张提单里最大的号，
 * 新号就会从它的编号开始，跟刚撕下来那张已打印的标签撞号。
 * 先取号 = 起点含原包，一定比原包大，不会复用。
 */
export function takeBarcodes(count, { shipmentId, shipmentNo, inboundOrderNo }) {
  const out = []
  let sequence = nextBaleSequence(shipmentId, inboundOrderNo)
  for (let guard = 0; out.length < count && guard < 1000; guard += 1) {
    const candidate = buildBaleNo(shipmentNo, inboundOrderNo, sequence)
    sequence += 1
    if (!findBaleByBarcode.get(candidate)) out.push(candidate)
  }
  if (out.length < count) {
    const error = new Error('条码号生成失败，请检查提单号 / 单号')
    error.status = 400
    throw error
  }
  return out
}

/**
 * 直接建一张码单（指定包号 / 条码号）并写入它的规格行。
 *
 * 入库那条路走的是 createBalesForItem（自己算包号、自己排条码号），
 * 拆包这条路包号和条码号都是调用方定好的，所以单独走这里。
 * 建完顺手把汇总列（立方 / 片数 / 主规格）算对。
 */
export function insertBaleWithItems({
  baleNo,
  barcode,
  boxNo,
  shipmentId,
  inboundOrderId,
  items,
}) {
  const scopeKey = baleScopeKey(shipmentId, inboundOrderId)
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO bales
         (bale_no, barcode, box_no, shipment_id, inbound_order_id, scope_key,
          species, grade, thickness, width, length, pieces, cubic, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'in_stock')`,
    )
    .run(
      baleNo,
      barcode,
      boxNo ?? null,
      shipmentId ?? null,
      inboundOrderId ?? null,
      scopeKey,
      items[0]?.species ?? null,
      items[0]?.grade ?? null,
      items[0]?.thickness ?? null,
      items[0]?.width ?? null,
      items[0]?.length ?? null,
    )

  const baleId = Number(lastInsertRowid)
  for (const item of items) {
    insertBaleItem.run({
      bale_id: baleId,
      brand: item.brand ?? null,
      species: item.species,
      grade: item.grade,
      thickness: item.thickness,
      width: item.width,
      length: item.length,
      pieces: item.pieces,
      cubic: roundTo(
        calcCubic(item.thickness, item.width, item.length, item.pieces, 1),
        4,
      ),
      unit_price_cents: item.unit_price_cents ?? null,
      // 这一行来自哪张入库单：由调用方带过来（拆包/合并时从源包继承），
      // 没带就按这一包挂的那张单
      src_inbound_order_id: item.src_inbound_order_id ?? inboundOrderId ?? null,
    })
  }
  refreshBaleSummary(baleId)

  return { id: baleId, bale_no: baleNo, barcode }
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

  /** 规格完全一致才算「原来是同一行」（品牌不参与匹配） */
  const sameSpec = (line, item) =>
    String(line.species ?? '') === String(item.species ?? '') &&
    String(line.grade ?? '') === String(item.grade ?? '') &&
    Number(line.thickness) === Number(item.thickness) &&
    Number(line.width) === Number(item.width) &&
    Number(line.length) === Number(item.length) &&
    Number(line.pieces) === Number(item.pieces)

  // 每一行最终用哪个单价 + 该带哪些包级字段
  const priced = items.map((item) => {
    const given = Number(item.unit_price_cents)
    /**
     * 一包里可能混了好几张入库单的货，所以「原行」要连着来源一起对：
     * 先按「规格 + 来源」精确找；调用方没给来源（码单编辑弹窗就是这样）时
     * 退化成只按规格找，并**继承找到的那一行的来源** —— 这样每行的账还是落在原单上。
     */
    const wanted = Number(item.src_inbound_order_id ?? 0)
    const old =
      before.find(
        (line) => sameSpec(line, item) && wanted > 0 && Number(line.src_inbound_order_id ?? 0) === wanted,
      ) ?? before.find((line) => sameSpec(line, item))

    let unitPriceCents
    if (Number.isFinite(given)) {
      unitPriceCents = given
    } else if (old?.unit_price_cents === null || old?.unit_price_cents === undefined) {
      // 找不到原价 → 交给 addOneBundleToOrder 用「该规格最近入库价」兜底
      unitPriceCents = undefined
    } else {
      unitPriceCents = Number(old.unit_price_cents)
    }

    return {
      ...item,
      brand: item.brand ?? old?.brand ?? null,
      /**
       * 柜号 / 包号是包级字段：重建时必须按这一包的现值继承下去。
       * 以前这里没带，导致「改包 / 码单编辑」重建入库明细后，
       * 明细里的柜号和包号被清空（编辑入库单时柜号空白、柜数变成 0）。
       */
      box_no: item.box_no ?? bale.box_no ?? null,
      bale_no: item.bale_no ?? bale.bale_no ?? null,
      unit_price_cents: unitPriceCents,
      // 这一行来自哪张入库单：调用方给了就用，否则继承原行，再不然算这一包的
      src_inbound_order_id:
        Number(item.src_inbound_order_id ?? old?.src_inbound_order_id ?? bale.inbound_order_id ?? 0) ||
        null,
    }
  })

  for (const item of priced) {
    insertBaleItem.run({
      bale_id: bale.id,
      brand: item.brand ?? null,
      species: item.species,
      grade: item.grade,
      thickness: item.thickness,
      width: item.width,
      length: item.length,
      pieces: item.pieces,
      cubic: item.cubic,
      unit_price_cents: item.unit_price_cents ?? null,
      src_inbound_order_id: item.src_inbound_order_id ?? null,
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

/**
 * 校验前端传来的规格行。
 *
 * 一行里可以写多段（混装包）：长度 `1800/2100/2400` 配片数 `17/30/247`
 * （规则见 utils/slashSpecs.js —— 厚度 / 宽度只能填一个数）。
 * 校验通过后每一行是：
 *   - `specs`：这一行的各段规格（普通行就是 1 段）；
 *   - `cubic`：这一行的**合计**立方（多段相加）；
 *   - `length` / `pieces`：保留第一段，老代码读这两个字段的地方行为不变；
 *   - `unit_price`：前端回的单价（0 = 没填，按成本自动算）。
 */
export function normalizeBaleItems(rawItems) {
  const items = Array.isArray(rawItems) ? rawItems : []
  const problems = []

  // 先把「一行多段」拆开：段数不齐、厚度/宽度写了斜杠都在这里报出来
  const expanded = expandSlashSpecs(items)
  problems.push(...expanded.problems)

  const normalized = expanded.items.map((raw, index) => {
    const species = String(raw.species ?? '').trim()
    const grade = String(raw.grade ?? '').trim()
    const thickness = Number(raw.thickness)
    const width = Number(raw.width)
    // 长度同样认毫米写法（1800 → 1.8m），和入库/出库那边一套口径
    const specs = specsOf(raw).map((spec) => ({
      length: toMeters(spec.length),
      pieces: Number(spec.pieces),
    }))

    const reasons = []
    if (!species) reasons.push('品名不能为空')
    if (!(thickness > 0 && thickness <= 1000)) reasons.push('厚度需在 0~1000mm')
    if (!(width > 0 && width <= 1000)) reasons.push('宽度需在 0~1000mm')
    specs.forEach((spec, seg) => {
      const at = specs.length > 1 ? `第 ${seg + 1} 段` : ''
      if (!(spec.length > 0 && spec.length <= 20)) reasons.push(`${at}长度需在 0~20m`)
      if (!(Number.isInteger(spec.pieces) && spec.pieces > 0)) {
        reasons.push(`${at}片数必须是大于 0 的整数`)
      }
    })
    if (reasons.length > 0) problems.push(`第 ${index + 1} 行：${reasons.join('；')}`)

    return {
      brand: String(raw.brand ?? '').trim(),
      species,
      grade,
      thickness,
      width,
      length: specs[0]?.length ?? NaN,
      pieces: specs[0]?.pieces ?? NaN,
      specs,
      cubic: roundTo(
        specs.reduce(
          (sum, spec) => sum + calcCubic(thickness, width, spec.length, spec.pieces, 1),
          0,
        ),
        4,
      ),
      unit_price: Number(raw.unit_price ?? 0),
      /**
       * 「这一行是从哪个源包搬过来的 / 属于哪张入库单」——**必须原样透传**。
       *
       * 前端在「复制改包前数据」「一键拆包」「复制本行」时都会带上 `srcBaleId`，
       * 改包后端 `sourceOrderOfSegment()`（routes/repacks.js）就是靠它判断
       * 「这一行的货到底属于哪张入库单」（优先级链里的第 ② 条）。
       *
       * 之前这里重建对象时只留了 10 个字段，把线索丢了 —— 于是只剩"按规格猜"：
       * 而**重新分配长度/片数本来就是改包的常规操作**，一改就猜不中，
       * 最后全落到「第一个源包那张入库单」的兜底上。后果有两个：
       *   1) 跨单合并的账记错（别的单的货算到第一张单名下）；
       *   2) 「不同提单必须填提单号」这条校验被绕过（两行都被算成同一张单 → 提单"看起来"一致）。
       */
      ...(Number(raw.srcBaleId ?? 0) > 0 ? { srcBaleId: Number(raw.srcBaleId) } : {}),
      ...(Number(raw.src_bale_id ?? 0) > 0 ? { src_bale_id: Number(raw.src_bale_id) } : {}),
      ...(Number(raw.src_inbound_order_id ?? 0) > 0
        ? { src_inbound_order_id: Number(raw.src_inbound_order_id) }
        : {}),
      ...(raw.src_bale_no ? { src_bale_no: String(raw.src_bale_no) } : {}),
    }
  })

  if (normalized.length === 0) problems.push('至少需要一个规格')
  return { items: normalized, problems }
}

/**
 * 把「行」摊成「一条条规格段」：一段规格 = 一条 bale_items / order_items 记录。
 *
 * 混装行（长度 1.8/2.1/2.4）在界面上是一行，落到库存里必须是三段；
 * 包级字段（品牌 / 包号 / 柜号 / 单价）原样带下去。
 */
export function specSegmentsOf(rows) {
  return (Array.isArray(rows) ? rows : []).flatMap((row) =>
    specsOf(row).map((spec) => ({
      ...row,
      length: spec.length,
      pieces: spec.pieces,
      cubic: roundTo(calcCubic(row.thickness, row.width, spec.length, spec.pieces, 1), 4),
    })),
  )
}

/** 码单详情（编辑弹窗用） */
router.get('/:id', (req, res) => {
  const id = Number(req.params.id)
  const bale = getBaleStmt.get(id)
  if (!bale) return res.status(404).json({ error: '码单不存在' })

  // 标签上要印提单号，这里顺手带出来
  const shipmentNo = bale.shipment_id
    ? db.prepare(`SELECT bl_no FROM shipments WHERE id = ?`).get(bale.shipment_id)?.bl_no
    : null

  res.json({
    id: bale.id,
    bale_no: bale.bale_no,
    barcode: bale.barcode ?? bale.bale_no ?? '',
    box_no: bale.box_no ?? '',
    bl_no: shipmentNo ?? '',
    shipment_id: bale.shipment_id ?? null,
    inbound_order_id: bale.inbound_order_id,
    status: bale.status,
    cubic: roundTo(bale.cubic ?? 0, 4),
    pieces: bale.pieces ?? 0,
    // 斜杠串（和列表同一个口径，见 BALE_TEXT_COLS）
    ...baleTextFields(bale),
    items: baleItemsStmt.all(id).map((item) => ({
      id: item.id,
      brand: item.brand ?? '',
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

  // 包号全局唯一；改包号时排除这一包自己（没改的话它本来就在库里）
  assertBaleNoAvailable(baleNo, { excludeBaleId: id })

  /**
   * 顺序不能反：先把新包号 / 柜号写进 bales，再用**新的包对象**重建明细。
   * 以前是先 replaceBaleItems 再 UPDATE，重建出来的入库明细写的是**旧包号**——
   * 结果就是「改了包号，采购入库明细里还是旧的」。
   */
  db.prepare(`UPDATE bales SET bale_no = ?, box_no = ? WHERE id = ?`).run(
    baleNo,
    boxNo || null,
    id,
  )
  const amounts = replaceBaleItems({ ...bale, bale_no: baleNo, box_no: boxNo || null }, items)

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

router.put('/:id', requireCap('bale.write'), (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '码单 ID 不合法' })
  }

  const body = req.body ?? {}
  const baleNo = String(body.bale_no ?? '').trim()
  // 包号允许留空：仓管没填就是空，系统不替他编一个
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

  // 前端把每一行原来的单价回传了：有（>0）就钉住它，没有就交给后端按原行/最近价兜底。
  // 混装行（一行多段）在这里摊成一段一条：库存是按段记的。
  const pricedItems = specSegmentsOf(
    items.map((item) =>
      Number(item.unit_price) > 0
        ? { ...item, unit_price_cents: toCents(item.unit_price) }
        : item,
    ),
  )

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

router.delete('/:id', requireCap('bale.write'), (req, res) => {
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
