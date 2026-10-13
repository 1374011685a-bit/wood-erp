import express from 'express'
import { db } from '../db.js'
import { toCents, fromCents } from '../utils/cubic.js'
import { buildWorkbook } from '../utils/excel.js'
import { pageParams } from '../utils/paging.js'

const router = express.Router()

const roundTo = (value, digits) => Number((value ?? 0).toFixed(digits))
const pad = (value) => String(value).padStart(2, '0')

/** 本地日期 YYYY-MM-DD */
function todayLocal(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 两种往来方向：
 * - customer：出库单形成应收，客户付款形成收款
 * - supplier：入库单形成应付，我们付款形成付款
 */
const SIDES = {
  customer: {
    label: '客户',
    orderType: 'out',
    orderTable: 'outbound_orders',
    partnerColumn: 'customer',
    prefix: 'SK',
    moneyLabel: '收款',
    orderLabel: '出库单',
  },
  supplier: {
    label: '供应商',
    orderType: 'in',
    orderTable: 'inbound_orders',
    partnerColumn: 'supplier',
    prefix: 'FK',
    moneyLabel: '付款',
    orderLabel: '入库单',
  },
}

function sideKey(value) {
  return String(value ?? '').trim() === 'supplier' ? 'supplier' : 'customer'
}

/**
 * 单据金额（分）：入库/出库单的明细合计。
 * 排除软删除的单据与明细，金额按整数分相加，对账数字分毫不差。
 */
function orderAmountStmt(cfg) {
  return db.prepare(
    `SELECT o.${cfg.partnerColumn} AS partner,
            o.id          AS order_id,
            o.order_no,
            o.order_date,
            o.created_at,
            COALESCE(SUM(COALESCE(i.amount_cents, ROUND(i.amount * 100))), 0) AS amount_cents,
            ROUND(COALESCE(SUM(i.cubic), 0), 4) AS cubic
       FROM ${cfg.orderTable} o
       LEFT JOIN order_items i
              ON i.order_id = o.id AND i.order_type = '${cfg.orderType}' AND i.deleted_at IS NULL
      WHERE o.deleted_at IS NULL
      GROUP BY o.id`,
  )
}

const paymentsBySideStmt = db.prepare(
  `SELECT id, payment_no, side, partner, amount_cents, pay_date, method, remark, created_at
     FROM payments
    WHERE side = ?
    ORDER BY pay_date, id`,
)

/* ---------- 往来余额总览 ---------- */

/**
 * 每个往来单位：累计发生、累计已收/已付、当前余额。
 * 余额 = 累计发生 - 累计收付；正数表示客户欠我们 / 我们欠供应商。
 */
router.get('/summary', (req, res) => {
  const key = sideKey(req.query.side)
  const cfg = SIDES[key]

  const buckets = new Map()
  const bucketOf = (partner) => {
    const name = String(partner ?? '').trim()
    if (!name) return null
    if (!buckets.has(name)) {
      buckets.set(name, {
        partner: name,
        order_amount_cents: 0,
        order_count: 0,
        paid_cents: 0,
        last_order_date: null,
      })
    }
    return buckets.get(name)
  }

  for (const row of orderAmountStmt(cfg).all()) {
    const bucket = bucketOf(row.partner)
    if (!bucket) continue
    bucket.order_amount_cents += Number(row.amount_cents ?? 0)
    bucket.order_count += 1
    const date = row.order_date ?? ''
    if (!bucket.last_order_date || date > bucket.last_order_date) {
      bucket.last_order_date = date
    }
  }

  for (const row of paymentsBySideStmt.all(key)) {
    const bucket = bucketOf(row.partner)
    if (!bucket) continue
    bucket.paid_cents += Number(row.amount_cents ?? 0)
  }

  const rows = [...buckets.values()]
    .map((bucket) => ({
      partner: bucket.partner,
      order_amount: fromCents(bucket.order_amount_cents),
      order_count: bucket.order_count,
      paid: fromCents(bucket.paid_cents),
      balance: fromCents(bucket.order_amount_cents - bucket.paid_cents),
      last_order_date: bucket.last_order_date,
    }))
    .sort((a, b) => b.balance - a.balance)

  const sumCents = (pick) =>
    rows.reduce((sum, row) => sum + Math.round(pick(row) * 100), 0)

  res.json({
    side: key,
    rows,
    totals: {
      order_amount: fromCents(sumCents((row) => row.order_amount)),
      paid: fromCents(sumCents((row) => row.paid)),
      balance: fromCents(sumCents((row) => row.balance)),
    },
  })
})

/* ---------- 对账单 ---------- */

/**
 * 期间对账单：期初余额 + 本期发生 - 本期收付 = 期末余额。
 * 期初 = date_from 之前的所有单据金额减去所有收付款；不传 date_from 就从头算（期初 0）。
 * 每行带滚动余额，直接能拿去跟客户/供应商核对。
 */
function buildStatement({ key, partner, dateFrom, dateTo }) {
  const cfg = SIDES[key]
  const entries = []

  for (const row of orderAmountStmt(cfg).all()) {
    if (String(row.partner ?? '').trim() !== partner) continue
    entries.push({
      kind: 'order',
      date: row.order_date ?? '',
      no: row.order_no,
      summary: `${cfg.orderLabel}`,
      cubic: roundTo(row.cubic ?? 0, 4),
      amount_cents: Number(row.amount_cents ?? 0),
      created_at: row.created_at ?? '',
    })
  }

  for (const row of paymentsBySideStmt.all(key)) {
    if (String(row.partner ?? '').trim() !== partner) continue
    const extra = [row.method, row.remark].filter(Boolean).join(' ')
    entries.push({
      kind: 'payment',
      date: row.pay_date ?? '',
      no: row.payment_no,
      summary: extra ? `${cfg.moneyLabel}（${extra}）` : cfg.moneyLabel,
      cubic: 0,
      amount_cents: -Number(row.amount_cents ?? 0),
      created_at: row.created_at ?? '',
    })
  }

  entries.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1
    return a.created_at < b.created_at ? -1 : 1
  })

  const openingCents = entries
    .filter((entry) => dateFrom && entry.date < dateFrom)
    .reduce((sum, entry) => sum + entry.amount_cents, 0)

  // entries 已按日期排序：期初之前的跳过（已计入期初），超出 date_to 的直接结束，
  // 这样期末余额不会被期间之后的单据带偏
  let running = openingCents
  const rows = []
  for (const entry of entries) {
    if (dateFrom && entry.date < dateFrom) continue
    if (dateTo && entry.date > dateTo) break

    running += entry.amount_cents
    rows.push({
      date: entry.date,
      kind: entry.kind,
      no: entry.no,
      summary: entry.summary,
      cubic: entry.cubic,
      amount: fromCents(entry.amount_cents),
      balance: fromCents(running),
    })
  }

  const periodOccurred = rows
    .filter((row) => row.kind === 'order')
    .reduce((sum, row) => sum + Math.round(row.amount * 100), 0)
  const periodPaid = -rows
    .filter((row) => row.kind === 'payment')
    .reduce((sum, row) => sum + Math.round(row.amount * 100), 0)

  return {
    side: key,
    partner,
    date_from: dateFrom ?? '',
    date_to: dateTo ?? '',
    opening: fromCents(openingCents),
    rows,
    period_occurred: fromCents(periodOccurred),
    period_paid: fromCents(periodPaid),
    closing: fromCents(running),
  }
}

router.get('/statement', (req, res) => {
  const key = sideKey(req.query.side)
  const partner = String(req.query.partner ?? '').trim()
  if (!partner) {
    return res.status(400).json({ error: '请指定往来单位' })
  }

  res.json(
    buildStatement({
      key,
      partner,
      dateFrom: String(req.query.date_from ?? '').trim(),
      dateTo: String(req.query.date_to ?? '').trim(),
    }),
  )
})

/* ---------- 收付款记录 ---------- */

function nextPaymentNo(key, payDate) {
  const cfg = SIDES[key]
  const head = `${cfg.prefix}${(payDate || todayLocal()).replace(/-/g, '')}`
  const last = db
    .prepare(
      `SELECT payment_no FROM payments
        WHERE payment_no LIKE ?
        ORDER BY payment_no DESC
        LIMIT 1`,
    )
    .get(`${head}%`)
  const next = last ? Number(last.payment_no.slice(head.length)) + 1 : 1
  return `${head}${String(next).padStart(4, '0')}`
}

router.get('/payments', (req, res) => {
  const key = sideKey(req.query.side)
  const cfg = SIDES[key]

  // 筛选：单号 / 往来单位 / 方式 / 日期范围，都用 LIKE 或区间比较，全部可选
  const conditions = [`side = ?`]
  const params = [key]

  const like = (value) => {
    const text = String(value ?? '').trim()
    return text ? `%${text}%` : ''
  }

  const noLike = like(req.query.payment_no)
  if (noLike) {
    conditions.push(`payment_no LIKE ?`)
    params.push(noLike)
  }

  const partnerLike = like(req.query.partner)
  if (partnerLike) {
    conditions.push(`partner LIKE ?`)
    params.push(partnerLike)
  }

  const methodLike = like(req.query.method)
  if (methodLike) {
    conditions.push(`method LIKE ?`)
    params.push(methodLike)
  }

  if (req.query.date_from) {
    conditions.push(`pay_date >= ?`)
    params.push(String(req.query.date_from))
  }
  if (req.query.date_to) {
    conditions.push(`pay_date <= ?`)
    params.push(String(req.query.date_to))
  }

  const where = `WHERE ${conditions.join(' AND ')}`
  const total = Number(
    db.prepare(`SELECT COUNT(*) AS total FROM payments ${where}`).get(...params)?.total ?? 0,
  )
  const { limit, offset } = pageParams(req.query)

  const rows = db
    .prepare(
      `SELECT id, payment_no, side, partner, amount_cents, pay_date, method, remark, created_at
         FROM payments
        ${where}
        ORDER BY pay_date DESC, id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset)
    .map((row) => ({
      id: row.id,
      payment_no: row.payment_no,
      side: row.side,
      partner: row.partner,
      amount: fromCents(row.amount_cents),
      pay_date: row.pay_date,
      method: row.method ?? '',
      remark: row.remark ?? '',
      created_at: row.created_at,
    }))

  // total_amount 是这一页之外的合计（当前筛选下的总金额），前端拿来显示「合计」
  const amountCents = Number(
    db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM payments ${where}`,
      )
      .get(...params)?.cents ?? 0,
  )

  res.json({
    total,
    limit,
    offset,
    total_amount: fromCents(amountCents),
    money_label: cfg.moneyLabel,
    rows,
  })
})

const insertPayment = db.prepare(
  `INSERT INTO payments (payment_no, side, partner, amount_cents, pay_date, method, remark)
   VALUES (@payment_no, @side, @partner, @amount_cents, @pay_date, @method, @remark)`,
)

// 新增收款 / 付款
router.post('/payments', (req, res) => {
  const body = req.body ?? {}
  const key = sideKey(body.side)
  const cfg = SIDES[key]
  const partner = String(body.partner ?? '').trim()
  const amountCents = toCents(body.amount)
  const payDate = body.pay_date ? String(body.pay_date) : todayLocal()
  const method = String(body.method ?? '').trim()
  const remark = String(body.remark ?? '').trim()

  if (!partner) {
    return res.status(400).json({ error: `${cfg.label}不能为空` })
  }
  if (!(amountCents > 0)) {
    return res.status(400).json({ error: '金额必须大于 0' })
  }

  try {
    const paymentNo = nextPaymentNo(key, payDate)
    insertPayment.run({
      payment_no: paymentNo,
      side: key,
      partner,
      amount_cents: amountCents,
      pay_date: payDate,
      method: method || null,
      remark: remark || null,
    })
    res.json({ ok: true, payment_no: paymentNo })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

const deletePaymentStmt = db.prepare(`DELETE FROM payments WHERE id = ?`)

// 删除收付款记录（记错了删掉重记，只是一条流水，不涉及库存）
router.delete('/payments/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '记录 ID 不合法' })
  }

  const result = deletePaymentStmt.run(id)
  if (result.changes === 0) {
    return res.status(404).json({ error: '记录不存在' })
  }
  res.json({ ok: true })
})

/* ---------- 导出对账单 ---------- */

function fileStamp(date = new Date()) {
  const day = todayLocal(date).replace(/-/g, '')
  return `${day}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function displayTime(date = new Date()) {
  return `${todayLocal(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

async function sendWorkbook(res, filename, options) {
  const buffer = await buildWorkbook(options)
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  )
  res.end(buffer)
}

router.get('/export', async (req, res) => {
  const key = sideKey(req.query.side)
  const cfg = SIDES[key]
  const partner = String(req.query.partner ?? '').trim()
  if (!partner) {
    return res.status(400).json({ error: '请指定往来单位' })
  }

  const statement = buildStatement({
    key,
    partner,
    dateFrom: String(req.query.date_from ?? '').trim(),
    dateTo: String(req.query.date_to ?? '').trim(),
  })

  const rows = [
    {
      date: statement.date_from || '—',
      kind: '期初',
      no: '',
      summary: '期初余额',
      amount: '',
      balance: statement.opening,
    },
    ...statement.rows.map((row) => ({
      date: row.date,
      kind: row.kind === 'order' ? cfg.orderLabel : `${cfg.moneyLabel}单`,
      no: row.no,
      summary: row.summary,
      amount: row.amount,
      balance: row.balance,
    })),
    {
      date: statement.date_to || '—',
      kind: '期末',
      no: '',
      summary: `本期发生 ${statement.period_occurred}，本期${cfg.moneyLabel} ${statement.period_paid}`,
      amount: '',
      balance: statement.closing,
    },
  ]

  await sendWorkbook(res, `对账单_${partner}_${fileStamp()}.xlsx`, {
    title: `立川木业木材管理系统 — ${cfg.label}对账单`,
    subtitle: `往来单位：${partner}　　期间：${statement.date_from || '不限'} ~ ${statement.date_to || '不限'}　　导出时间：${displayTime()}`,
    columns: [
      { key: 'date', header: '日期', type: 'text' },
      { key: 'kind', header: '类型', type: 'text' },
      { key: 'no', header: '单号', type: 'text' },
      { key: 'summary', header: '摘要', type: 'text' },
      { key: 'amount', header: '发生金额', type: 'number', decimals: 2 },
      { key: 'balance', header: '余额', type: 'number', decimals: 2 },
    ],
    rows,
    totals: { date: '期末余额', balance: statement.closing },
  })
})

export default router
