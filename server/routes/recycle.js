import express from 'express'
import { db } from '../db.js'
import { assertBaleNoAvailable } from './bales.js'
import { removeContractFile } from './contracts.js'
import { writeLog } from '../boot-log.js'
import { requireCap } from '../middleware/permissions.js'

const router = express.Router()

const roundTo = (value, digits) => Number((value ?? 0).toFixed(digits))

/** 回收站里能出现的三种单据类型 */
const RECYCLE_TYPES = new Set(['in', 'out', 'contract'])

/**
 * 回收站：列出软删除的合同 / 入库单 / 出库单。
 * 明细也一起打了删除标记，所以这些单据已经完全退出库存、流水和导出。
 *
 * 合同那一档：删合同是「整串移入回收站」（提单 → 入库单 → 明细 → 包），
 * 所以下面那些入库单由合同这条代表，不在列表里重复出现（恢复合同整串带回来）。
 */
const listSql = `
  SELECT 'in' AS type,
         o.id,
         o.order_no,
         o.supplier AS partner,
         o.order_date,
         o.deleted_at,
         ROUND(COALESCE(SUM(i.cubic), 0), 4)  AS total_cubic,
         ROUND(COALESCE(SUM(COALESCE(i.amount_cents, ROUND(i.amount * 100))), 0) / 100.0, 2)
                                              AS total_amount,
         COUNT(i.id)                          AS item_count
    FROM inbound_orders o
    LEFT JOIN order_items i ON i.order_id = o.id AND i.order_type = 'in'
   WHERE o.deleted_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM contracts c
                      WHERE c.deleted_at IS NOT NULL
                        AND c.contract_no = o.contract_no)
   GROUP BY o.id

   UNION ALL

  SELECT 'out' AS type,
         o.id,
         o.order_no,
         o.customer AS partner,
         o.order_date,
         o.deleted_at,
         ROUND(COALESCE(SUM(i.cubic), 0), 4)  AS total_cubic,
         ROUND(COALESCE(SUM(COALESCE(i.amount_cents, ROUND(i.amount * 100))), 0) / 100.0, 2)
                                              AS total_amount,
         COUNT(i.id)                          AS item_count
    FROM outbound_orders o
    LEFT JOIN order_items i ON i.order_id = o.id AND i.order_type = 'out'
   WHERE o.deleted_at IS NOT NULL
   GROUP BY o.id

   UNION ALL

  /*
   * 合同：立方 / 金额按这张合同下**所有**入库明细（含软删）合计，
   * 「明细数」那一列放的是这张合同下的入库单张数。
   */
  SELECT 'contract' AS type,
         c.id,
         c.contract_no AS order_no,
         c.partner,
         c.sign_date   AS order_date,
         c.deleted_at,
         (SELECT ROUND(COALESCE(SUM(i.cubic), 0), 4)
            FROM order_items i
            JOIN inbound_orders o ON o.id = i.order_id
           WHERE i.order_type = 'in' AND o.contract_no = c.contract_no)
                                               AS total_cubic,
         (SELECT ROUND(COALESCE(SUM(COALESCE(i.amount_cents, ROUND(i.amount * 100))), 0) / 100.0, 2)
            FROM order_items i
            JOIN inbound_orders o ON o.id = i.order_id
           WHERE i.order_type = 'in' AND o.contract_no = c.contract_no)
                                               AS total_amount,
         (SELECT COUNT(*) FROM inbound_orders o WHERE o.contract_no = c.contract_no)
                                               AS item_count
    FROM contracts c
   WHERE c.deleted_at IS NOT NULL
`

router.get('/', (_req, res) => {
  const rows = db
    .prepare(`SELECT * FROM (${listSql}) ORDER BY deleted_at DESC, id DESC`)
    .all()

  res.json(
    rows.map((row) => ({
      type: row.type,
      id: row.id,
      order_no: row.order_no,
      partner: row.partner,
      order_date: row.order_date,
      deleted_at: row.deleted_at,
      total_cubic: roundTo(row.total_cubic ?? 0, 4),
      total_amount: roundTo(row.total_amount ?? 0, 2),
      item_count: row.item_count ?? 0,
    })),
  )
})

/* ---------- 恢复 ---------- */

const findDeletedStmt = {
  in: db.prepare(
    `SELECT id, order_no, shipment_id FROM inbound_orders WHERE id = ? AND deleted_at IS NOT NULL`,
  ),
  out: db.prepare(
    `SELECT id, order_no FROM outbound_orders WHERE id = ? AND deleted_at IS NOT NULL`,
  ),
  contract: db.prepare(
    `SELECT id, contract_no FROM contracts WHERE id = ? AND deleted_at IS NOT NULL`,
  ),
}

const restoreOrderStmt = {
  in: db.prepare(`UPDATE inbound_orders SET deleted_at = NULL WHERE id = ?`),
  out: db.prepare(`UPDATE outbound_orders SET deleted_at = NULL WHERE id = ?`),
  contract: db.prepare(`UPDATE contracts SET deleted_at = NULL WHERE id = ?`),
}

const restoreItemsStmt = {
  in: db.prepare(
    `UPDATE order_items SET deleted_at = NULL WHERE order_type = 'in' AND order_id = ?`,
  ),
  out: db.prepare(
    `UPDATE order_items SET deleted_at = NULL WHERE order_type = 'out' AND order_id = ?`,
  ),
}

/** 某规格当前库存（只看未删除的明细） */
const stockOfSpecStmt = db.prepare(
  `SELECT COALESCE(SUM(CASE WHEN order_type = 'in' THEN cubic   ELSE -cubic   END), 0) AS cubic,
          COALESCE(SUM(CASE WHEN order_type = 'in' THEN bundles ELSE -bundles END), 0) AS bundles
     FROM order_items
    WHERE deleted_at IS NULL
      AND species = ?
      AND COALESCE(grade, '') = ?
      AND thickness = ?
      AND width     = ?
      AND length    = ?`,
)

const orderItemsStmt = db.prepare(
  `SELECT species, grade, thickness, width, length, cubic, bundles
     FROM order_items
    WHERE order_type = ? AND order_id = ?`,
)

/**
 * 恢复入库单（或整串合同）之前要看的三个东西：
 *   1) 这些单下面、目前还是软删状态的包（恢复时它们会一起活过来）
 *   2) 这些单挂的提单（拿它的号去查重）
 *   3) 库里活着的同名提单（大小写不敏感 + 去空格，排除自己这张）
 */
const deletedBalesStmt = db.prepare(
  `SELECT id, bale_no, barcode
     FROM bales
    WHERE inbound_order_id = ? AND deleted_at IS NOT NULL
    ORDER BY id`,
)
const shipmentByIdStmt = db.prepare(`SELECT id, bl_no, deleted_at FROM shipments WHERE id = ?`)
const liveShipmentByBlNoStmt = db.prepare(
  `SELECT id, bl_no FROM shipments
    WHERE lower(trim(bl_no)) = lower(trim(?))
      AND deleted_at IS NULL AND id <> ?`,
)

/** 一张软删合同下面、跟着一起打了删除标记的入库单 / 提单 */
const deletedInboundOrdersOfContractStmt = db.prepare(
  `SELECT id FROM inbound_orders WHERE contract_no = ? AND deleted_at IS NOT NULL ORDER BY id`,
)
const deletedShipmentsOfContractStmt = db.prepare(
  `SELECT id FROM shipments WHERE contract_no = ? AND deleted_at IS NOT NULL ORDER BY id`,
)

/**
 * 恢复入库单 / 合同前的包号查重。
 *
 * 包号是「软删不占号」的口径 —— 索引是 `... WHERE deleted_at IS NULL` 的部分唯一索引。
 * 单子躺在回收站里的时候，它的包号是**腾出来**的，别人完全可以拿去用；一旦恢复，
 * 那两行同时「活」过来，唯一索引当场就炸，用户看到的是
 * `UNIQUE constraint failed: bales.bale_no` 这种原始英文报错。
 *
 * 所以在写库之前先按同一套口径查一遍，命中就给一句能照着做的中文提示。
 */
function assertBaleNosFree(orderIds) {
  for (const orderId of orderIds) {
    for (const bale of deletedBalesStmt.all(orderId)) {
      const key = String(bale.bale_no ?? '').trim()
      if (!key) continue
      try {
        // 口径复用 bales.js 那一份，别在这里另写一套
        assertBaleNoAvailable(key, { excludeBaleId: bale.id })
      } catch (err) {
        if (err?.status !== 400) throw err
        const error = new Error(`包号 ${key} 已经被别的包用了，请先改包再恢复这张单`)
        error.status = 400
        throw error
      }
    }
  }
}

/** 恢复前的提单号查重：待恢复的每张提单都不能和还活着的提单撞号 */
function assertBlNosFree(shipmentIds) {
  for (const shipmentId of shipmentIds) {
    const shipment = shipmentByIdStmt.get(shipmentId)
    const blNo = String(shipment?.bl_no ?? '').trim()
    if (!blNo) continue
    const clash = liveShipmentByBlNoStmt.get(blNo, shipment.id)
    if (clash) {
      const error = new Error(
        `提单号 ${blNo} 已经有一张活着的提单了，请先合并或改名再恢复这张单`,
      )
      error.status = 400
      throw error
    }
  }
}

/**
 * 恢复单据。
 *
 * 恢复入库单只会把货加回来，永远安全；
 * 恢复出库单等于重新扣一次库存，所以要确认当前库存够扣（和出库保存同一套判断），
 * 不够就整体回滚并说清楚差在哪。
 * 恢复合同就是恢复整串（合同 → 提单 → 入库单 → 明细 → 包），
 * 里面装的都是入库，同样只会把货加回来。
 */
const restoreOrder = db.transaction((type, id) => {
  const order = findDeletedStmt[type].get(id)
  if (!order) {
    const error = new Error('回收站里没有这张单据（可能已经恢复或彻底删除了）')
    error.status = 404
    throw error
  }

  if (type === 'out') {
    // 同规格的多行先合并
    const groups = new Map()
    for (const item of orderItemsStmt.all('out', id)) {
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
      const currentCubic = roundTo(stock?.cubic ?? 0, 4)
      const currentBundles = stock?.bundles ?? 0
      const afterCubic = roundTo(currentCubic - group.cubic, 4)
      const afterBundles = currentBundles - group.bundles

      if (afterCubic < 0 || afterBundles < 0) {
        problems.push(
          `无法恢复：${group.species}（等级 ${group.grade || '—'}）` +
            `厚${group.thickness}×宽${group.width}×长${group.length}，` +
            `当前库存 ${currentCubic} 立方 / ${currentBundles} 件，` +
            `恢复这张出库单后会变成 ${afterCubic} 立方 / ${afterBundles} 件，库存不能为负`,
        )
      }
    }

    if (problems.length > 0) {
      const error = new Error(problems.join('\n'))
      error.status = 400
      throw error
    }
  }

  /*
   * 查重放在写库之前：这时候还没写任何东西，出错直接回滚。
   * 口径见 assertBaleNosFree / assertBlNosFree。
   */
  if (type === 'in') {
    assertBaleNosFree([id])
    assertBlNosFree([order.shipment_id])
  }

  /*
   * 合同：整串还原。
   *
   * 删合同是「整串移入回收站」（contracts.js 的 removeContract），所以恢复也按
   * 合同号把那一串全捞回来 —— 合同本身、它的提单、入库单、入库明细、包。
   * 恢复的是「这个合同号名下的东西」，和删的时候同一套口径，前后对称。
   */
  if (type === 'contract') {
    const contractNo = String(order.contract_no ?? '')
    const orderIds = deletedInboundOrdersOfContractStmt.all(contractNo).map((row) => row.id)

    assertBaleNosFree(orderIds)
    assertBlNosFree(deletedShipmentsOfContractStmt.all(contractNo).map((row) => row.id))

    restoreOrderStmt.contract.run(id)
    db.prepare(
      `UPDATE shipments SET deleted_at = NULL
        WHERE contract_no = ? AND deleted_at IS NOT NULL`,
    ).run(contractNo)

    if (orderIds.length > 0) {
      const list = orderIds.join(',')
      db.prepare(`UPDATE inbound_orders SET deleted_at = NULL WHERE id IN (${list})`).run()
      db.prepare(
        `UPDATE order_items SET deleted_at = NULL
          WHERE order_type = 'in' AND order_id IN (${list})`,
      ).run()
      db.prepare(
        `UPDATE bales SET deleted_at = NULL
          WHERE inbound_order_id IN (${list}) AND deleted_at IS NOT NULL`,
      ).run()
    }

    return order
  }

  restoreItemsStmt[type].run(id)
  restoreOrderStmt[type].run(id)

  // 入库单恢复时：把包一起恢复，并把跟着软删的提单也带回来
  if (type === 'in') {
    db.prepare(
      `UPDATE bales SET deleted_at = NULL
        WHERE inbound_order_id = ? AND deleted_at IS NOT NULL`,
    ).run(id)
    if (order.shipment_id) {
      db.prepare(`UPDATE shipments SET deleted_at = NULL WHERE id = ?`).run(order.shipment_id)
    }
  }

  /*
   * 出库单恢复时：当初发走的码单要重新变回「已出库」。
   *
   * 撤销出库只把包改回在库、**留着** outbound_order_id 指针（见 outbound.js 的
   * releaseBalesStmt），这里就按这个指针把包扣回去 —— 库存在上面已经扣了，
   * 包状态跟着走，两边才对称。
   */
  if (type === 'out') {
    db.prepare(
      `UPDATE bales
          SET status = 'shipped',
              shipped_at = datetime('now', 'localtime')
        WHERE outbound_order_id = ? AND status = 'in_stock' AND deleted_at IS NULL`,
    ).run(id)
  }

  return order
})

router.post('/restore', requireCap('recycle.write'), (req, res) => {
  const type = String(req.body?.type ?? '')
  const id = Number(req.body?.id)

  if (!RECYCLE_TYPES.has(type)) {
    return res.status(400).json({ error: '单据类型不合法' })
  }
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '单据 ID 不合法' })
  }

  try {
    restoreOrder(type, id)
    res.json({ ok: true })
  } catch (err) {
    if (err.status === 400 || err.status === 404) {
      return res.status(err.status).json({ error: err.message })
    }
    /**
     * 兜底：万一还有没预检到的唯一约束（以后又加了别的部分唯一索引之类），
     * 别把 `UNIQUE constraint failed: xxx` 这种原始英文直接丢给用户。
     */
    if (String(err?.message ?? '').includes('UNIQUE')) {
      writeLog(`[recycle] 恢复时撞唯一约束：${err.message}`)
      return res.status(400).json({
        error:
          '恢复不了：这张单里的包号 / 提单号已经被别的记录用着了，' +
          '请先处理掉冲突（改包或合并提单）再恢复',
      })
    }
    res.status(500).json({ error: err.message })
  }
})

/* ---------- 彻底删除 ---------- */

const purgeOrderStmt = {
  in: db.prepare(`DELETE FROM inbound_orders WHERE id = ? AND deleted_at IS NOT NULL`),
  out: db.prepare(`DELETE FROM outbound_orders WHERE id = ? AND deleted_at IS NOT NULL`),
}

const purgeItemsStmt = {
  in: db.prepare(`DELETE FROM order_items WHERE order_type = 'in' AND order_id = ?`),
  out: db.prepare(`DELETE FROM order_items WHERE order_type = 'out' AND order_id = ?`),
}

// 彻底删入库单时，连同已经软删的包和它的提单一起清掉，不留垃圾
function purgeInboundExtras(orderId) {
  const order = db
    .prepare(`SELECT shipment_id FROM inbound_orders WHERE id = ?`)
    .get(orderId)
  const bales = db
    .prepare(`SELECT id FROM bales WHERE inbound_order_id = ?`)
    .all(orderId)
  for (const bale of bales) {
    db.prepare(`DELETE FROM bale_items WHERE bale_id = ?`).run(bale.id)
  }
  db.prepare(`DELETE FROM bales WHERE inbound_order_id = ?`).run(orderId)

  if (order?.shipment_id) {
    const left = Number(
      db
        .prepare(
          `SELECT COUNT(*) AS total FROM bales
            WHERE shipment_id = ? AND deleted_at IS NULL`,
        )
        .get(order.shipment_id)?.total ?? 0,
    )
    if (left === 0) {
      db.prepare(`DELETE FROM shipments WHERE id = ?`).run(order.shipment_id)
    }
  }
}

/**
 * 彻底删合同：整串物理删（合同 → 提单 → 入库单 → 明细 → 包），
 * 连合同 PDF 一起清掉，不留垃圾。
 *
 * 只动「已经打了删除标记」的那些行（本来就是删除状态，物理删掉不影响任何库存数字）；
 * 要是中途有哪张单被恢复过，就绕过它，别把活数据删了。
 */
function purgeContract(contract) {
  const contractNo = String(contract.contract_no ?? '')
  const orderIds = deletedInboundOrdersOfContractStmt
    .all(contractNo)
    .map((row) => row.id)

  if (orderIds.length > 0) {
    const list = orderIds.join(',')
    for (const bale of db.prepare(`SELECT id FROM bales WHERE inbound_order_id IN (${list})`).all()) {
      db.prepare(`DELETE FROM bale_items WHERE bale_id = ?`).run(bale.id)
    }
    db.prepare(`DELETE FROM bales WHERE inbound_order_id IN (${list})`).run()
    db.prepare(`DELETE FROM order_items WHERE order_type = 'in' AND order_id IN (${list})`).run()
    db.prepare(`DELETE FROM inbound_orders WHERE id IN (${list})`).run()
  }

  db.prepare(`DELETE FROM shipments WHERE contract_no = ? AND deleted_at IS NOT NULL`).run(
    contractNo,
  )
  db.prepare(`DELETE FROM contract_items WHERE contract_id = ?`).run(contract.id)

  // 合同行要留到最后：上面的 file_name / contract_no 都是从它身上读的
  const file = db
    .prepare(`SELECT file_name FROM contracts WHERE id = ?`)
    .get(contract.id)?.file_name
  db.prepare(`DELETE FROM contracts WHERE id = ? AND deleted_at IS NOT NULL`).run(contract.id)
  removeContractFile(file)
}

// 明细本来就是删除状态，物理删掉不影响任何库存数字
const purgeOrder = db.transaction((type, id) => {
  const order = findDeletedStmt[type].get(id)
  if (!order) {
    const error = new Error('回收站里没有这张单据（可能已经恢复或彻底删除了）')
    error.status = 404
    throw error
  }

  if (type === 'contract') {
    purgeContract(order)
    return order
  }

  purgeItemsStmt[type].run(id)
  if (type === 'in') purgeInboundExtras(id)
  // 出库单物理删掉之后，包上那个「当初被这张单发走」的指针就成了悬空引用，清掉
  if (type === 'out') {
    db.prepare(`UPDATE bales SET outbound_order_id = NULL WHERE outbound_order_id = ?`).run(id)
  }
  purgeOrderStmt[type].run(id)
  return order
})

router.delete('/:type/:id', requireCap('recycle.write'), (req, res) => {
  const type = String(req.params.type)
  const id = Number(req.params.id)

  if (!RECYCLE_TYPES.has(type)) {
    return res.status(400).json({ error: '单据类型不合法' })
  }
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '单据 ID 不合法' })
  }

  try {
    purgeOrder(type, id)
    res.json({ ok: true })
  } catch (err) {
    if (err.status === 400 || err.status === 404) {
      return res.status(err.status).json({ error: err.message })
    }
    res.status(500).json({ error: err.message })
  }
})

export default router
