import express from 'express'
import { db } from '../db.js'
import { fromCents } from '../utils/cubic.js'
import { buildWorkbook } from '../utils/excel.js'

const router = express.Router()

const roundTo = (value, digits) => Number((value ?? 0).toFixed(digits))
const pad = (value) => String(value).padStart(2, '0')

/** 文件名用的时间戳：20261012_194530 */
function fileStamp(date = new Date()) {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/** 表头里展示的导出时间：2026-10-12 19:45:30 */
function displayTime(date = new Date()) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/** 统一发送 xlsx（中文文件名走 RFC 5987 编码，避免乱码） */
async function sendWorkbook(res, fileName, options) {
  const buffer = await buildWorkbook(options)

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  )
  res.setHeader('Content-Length', buffer.length)
  res.send(buffer)
}

const ORDER_ITEM_COLUMNS = [
  { key: 'order_no', header: '单号', type: 'text' },
  { key: 'order_date', header: '日期', type: 'text' },
  { key: 'partner', header: '往来单位', type: 'text' },
  { key: 'species', header: '品名', type: 'text' },
  { key: 'grade', header: '等级', type: 'text' },
  { key: 'thickness', header: '厚度(mm)', type: 'number', decimals: 0 },
  { key: 'width', header: '宽度(mm)', type: 'number', decimals: 0 },
  { key: 'length', header: '长度(m)', type: 'number', decimals: 2 },
  { key: 'pieces', header: '片数', type: 'integer' },
  { key: 'bundles', header: '件数', type: 'integer' },
  { key: 'cubic', header: '立方', type: 'number', decimals: 4 },
  { key: 'unit_price', header: '单价', type: 'number', decimals: 2 },
  { key: 'amount', header: '金额', type: 'number', decimals: 2 },
  { key: 'remark', header: '备注', type: 'text' },
]

/* ---------- 入库明细 ---------- */

const inboundRowsSql = (where) => `
  SELECT o.order_no,
         o.order_date,
         o.supplier AS partner,
         o.remark,
         i.species,
         i.grade,
         i.thickness,
         i.width,
         i.length,
         i.pieces,
         i.bundles,
         i.cubic,
         COALESCE(i.unit_price_cents, ROUND(i.unit_price * 100)) / 100.0 AS unit_price,
         COALESCE(i.amount_cents,     ROUND(i.amount     * 100))       AS amount_cents,
         COALESCE(i.amount_cents,     ROUND(i.amount     * 100)) / 100.0 AS amount
    FROM inbound_orders o
    JOIN order_items i
      ON i.order_id = o.id AND i.order_type = 'in' AND i.deleted_at IS NULL
   ${where}
   ORDER BY o.created_at DESC, o.id DESC, i.id
`

router.get('/inbound', async (req, res) => {
  const { supplier, date_from: dateFrom, date_to: dateTo } = req.query
  // 软删除的单据不导出
  const conditions = [`o.deleted_at IS NULL`]
  const params = []

  if (supplier && String(supplier).trim()) {
    conditions.push(`o.supplier LIKE ?`)
    params.push(`%${String(supplier).trim()}%`)
  }
  if (dateFrom) {
    conditions.push(`o.order_date >= ?`)
    params.push(String(dateFrom))
  }
  if (dateTo) {
    conditions.push(`o.order_date <= ?`)
    params.push(String(dateTo))
  }

  let amountCents = 0
  const rows = db
    .prepare(inboundRowsSql(conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''))
    .all(...params)
    .map((row) => {
      amountCents += Number(row.amount_cents ?? 0)
      return {
        ...row,
        grade: row.grade ?? '',
        remark: row.remark ?? '',
        cubic: roundTo(row.cubic, 4),
        amount: roundTo(row.amount, 2),
      }
    })

  const columns = ORDER_ITEM_COLUMNS.map((column) =>
    column.key === 'partner' ? { ...column, header: '供应商' } : column,
  )
  const totals = {
    order_no: '合计',
    cubic: roundTo(rows.reduce((sum, row) => sum + row.cubic, 0), 4),
    amount: fromCents(amountCents),
  }

  await sendWorkbook(res, `入库明细_${fileStamp()}.xlsx`, {
    title: '立川木业木材管理系统 — 入库明细',
    subtitle: `导出时间：${displayTime()}　　共 ${rows.length} 条`,
    columns,
    rows,
    totals,
  })
})

/* ---------- 出库明细 ---------- */

const outboundRowsSql = (where) => `
  SELECT o.order_no,
         o.order_date,
         o.customer AS partner,
         o.remark,
         i.species,
         i.grade,
         i.thickness,
         i.width,
         i.length,
         i.pieces,
         i.bundles,
         i.cubic,
         COALESCE(i.unit_price_cents, ROUND(i.unit_price * 100)) / 100.0 AS unit_price,
         COALESCE(i.amount_cents,     ROUND(i.amount     * 100))       AS amount_cents,
         COALESCE(i.amount_cents,     ROUND(i.amount     * 100)) / 100.0 AS amount
    FROM outbound_orders o
    JOIN order_items i
      ON i.order_id = o.id AND i.order_type = 'out' AND i.deleted_at IS NULL
   ${where}
   ORDER BY o.created_at DESC, o.id DESC, i.id
`

router.get('/outbound', async (req, res) => {
  const { customer, date_from: dateFrom, date_to: dateTo } = req.query
  // 软删除的单据不导出
  const conditions = [`o.deleted_at IS NULL`]
  const params = []

  if (customer && String(customer).trim()) {
    conditions.push(`o.customer LIKE ?`)
    params.push(`%${String(customer).trim()}%`)
  }
  if (dateFrom) {
    conditions.push(`o.order_date >= ?`)
    params.push(String(dateFrom))
  }
  if (dateTo) {
    conditions.push(`o.order_date <= ?`)
    params.push(String(dateTo))
  }

  let amountCents = 0
  const rows = db
    .prepare(outboundRowsSql(conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''))
    .all(...params)
    .map((row) => {
      amountCents += Number(row.amount_cents ?? 0)
      return {
        ...row,
        grade: row.grade ?? '',
        remark: row.remark ?? '',
        cubic: roundTo(row.cubic, 4),
        amount: roundTo(row.amount, 2),
      }
    })

  const columns = ORDER_ITEM_COLUMNS.map((column) =>
    column.key === 'partner' ? { ...column, header: '客户' } : column,
  )
  const totals = {
    order_no: '合计',
    cubic: roundTo(rows.reduce((sum, row) => sum + row.cubic, 0), 4),
    amount: fromCents(amountCents),
  }

  await sendWorkbook(res, `出库明细_${fileStamp()}.xlsx`, {
    title: '立川木业木材管理系统 — 出库明细',
    subtitle: `导出时间：${displayTime()}　　共 ${rows.length} 条`,
    columns,
    rows,
    totals,
  })
})

/* ---------- 库存表 ---------- */

const stockRowsSql = (hasSpeciesFilter) => `
  SELECT i.species,
         i.grade,
         i.thickness,
         i.width,
         i.length,
         SUM(CASE WHEN i.order_type = 'in' THEN i.bundles ELSE -i.bundles END) AS bundles,
         SUM(CASE WHEN i.order_type = 'in'
                  THEN i.pieces * i.bundles
                  ELSE -i.pieces * i.bundles END) AS pieces,
         SUM(CASE WHEN i.order_type = 'in' THEN i.cubic ELSE -i.cubic END) AS cubic,
         (SELECT COALESCE(s.unit_price_cents, ROUND(s.unit_price * 100))
            FROM order_items s
           WHERE s.order_type = 'in'
             AND s.deleted_at IS NULL
             AND COALESCE(s.species, '') = COALESCE(i.species, '')
             AND COALESCE(s.grade, '')   = COALESCE(i.grade, '')
             AND s.thickness = i.thickness
             AND s.width     = i.width
             AND s.length    = i.length
           ORDER BY s.id DESC
           LIMIT 1) AS unit_price_cents
    FROM order_items i
   WHERE i.deleted_at IS NULL
   ${hasSpeciesFilter ? `AND i.species LIKE ?` : ''}
   GROUP BY i.species, i.grade, i.thickness, i.width, i.length
  HAVING SUM(CASE WHEN i.order_type = 'in' THEN i.cubic ELSE -i.cubic END) > 0
   ORDER BY i.species, i.grade, i.thickness, i.width, i.length
`

router.get('/stock', async (req, res) => {
  const species = String(req.query.species ?? '').trim()
  const params = species ? [`%${species}%`] : []

  let amountCents = 0
  const rows = db
    .prepare(stockRowsSql(Boolean(species)))
    .all(...params)
    .map((row) => {
      const cubic = roundTo(row.cubic, 4)
      const unitPriceCents = Number(row.unit_price_cents ?? 0)
      const rowAmountCents = Math.round(cubic * unitPriceCents)
      amountCents += rowAmountCents
      return {
        species: row.species,
        grade: row.grade ?? '',
        thickness: row.thickness,
        width: row.width,
        length: row.length,
        bundles: row.bundles ?? 0,
        pieces: row.pieces ?? 0,
        cubic,
        unit_price: Number((unitPriceCents / 100).toFixed(2)),
        amount: fromCents(rowAmountCents),
      }
    })

  const columns = [
    { key: 'species', header: '品名', type: 'text' },
    { key: 'grade', header: '等级', type: 'text' },
    { key: 'thickness', header: '厚度(mm)', type: 'number', decimals: 0 },
    { key: 'width', header: '宽度(mm)', type: 'number', decimals: 0 },
    { key: 'length', header: '长度(m)', type: 'number', decimals: 2 },
    { key: 'bundles', header: '当前件数', type: 'integer' },
    { key: 'pieces', header: '当前片数', type: 'integer' },
    { key: 'cubic', header: '当前立方', type: 'number', decimals: 4 },
    { key: 'unit_price', header: '最近入库单价', type: 'number', decimals: 2 },
    { key: 'amount', header: '库存金额', type: 'number', decimals: 2 },
  ]

  const totals = {
    species: '合计',
    bundles: rows.reduce((sum, row) => sum + row.bundles, 0),
    pieces: rows.reduce((sum, row) => sum + row.pieces, 0),
    cubic: roundTo(rows.reduce((sum, row) => sum + row.cubic, 0), 4),
    amount: fromCents(amountCents),
  }

  await sendWorkbook(res, `库存表_${fileStamp()}.xlsx`, {
    title: '立川木业木材管理系统 — 库存表',
    subtitle: `导出时间：${displayTime()}　　共 ${rows.length} 条`,
    columns,
    rows,
    totals,
  })
})

export default router
