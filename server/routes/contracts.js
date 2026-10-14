import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import multer from 'multer'
import { db, storageDir } from '../db.js'
import { toCents, fromCents } from '../utils/cubic.js'
import { pageParams } from '../utils/paging.js'
import { requireCap } from '../middleware/permissions.js'
import { keepPricesFrom, contractItemKey } from '../utils/keepPrices.js'

const router = express.Router()

/**
 * 合同 PDF 存在数据目录下：<DATA_DIR>/uploads/contracts/
 * 放在数据目录里，Railway / Sealos 挂载卷换了也不会丢。
 */
export const contractDir = path.join(storageDir, 'uploads', 'contracts')
fs.mkdirSync(contractDir, { recursive: true })

const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20MB

// 先收在内存里，校验通过再落到磁盘（文件名我们自己生成，不用原始名）
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
})

const roundTo = (value, digits) => Number((value ?? 0).toFixed(digits))

/* ---------- 合同明细：只记「定了什么货」——品牌 / 品名 / 等级 / 数量 / 单价 / 金额 ---------- */

const insertContractItem = db.prepare(
  `INSERT INTO contract_items
     (contract_id, brand, species, grade, quantity, unit_price_cents, amount_cents, remark)
   VALUES (@contract_id, @brand, @species, @grade, @quantity, @unit_price_cents, @amount_cents, @remark)`,
)
const deleteContractItems = db.prepare(`DELETE FROM contract_items WHERE contract_id = ?`)
const listContractItems = db.prepare(
  `SELECT * FROM contract_items WHERE contract_id = ? ORDER BY id`,
)

const itemToApi = (row) => ({
  id: row.id,
  brand: row.brand ?? '',
  species: row.species ?? '',
  grade: row.grade ?? '',
  quantity: roundTo(row.quantity ?? 0, 3),
  unit_price: fromCents(row.unit_price_cents ?? 0),
  amount: fromCents(row.amount_cents ?? 0),
  remark: row.remark ?? '',
})

/** 表单里的明细是 JSON 字符串（multipart），解析一下 */
function readRawItems(body) {
  const raw = body?.items
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const list = JSON.parse(raw)
    return Array.isArray(list) ? list : null
  } catch {
    return null
  }
}

function normalizeContractItems(rawItems) {
  const items = []
  const problems = []
  rawItems.forEach((item, index) => {
    const brand = String(item?.brand ?? '').trim()
    const species = String(item?.species ?? '').trim()
    const grade = String(item?.grade ?? '').trim()
    const remark = String(item?.remark ?? '').trim()
    const quantity = Number(item?.quantity)
    const priceCents = toCents(item?.unit_price ?? 0)

    // 整行空着就跳过
    if (!brand && !species && !quantity) return

    const reasons = []
    if (!species) reasons.push('品名不能为空')
    if (!(Number.isFinite(quantity) && quantity > 0)) reasons.push('数量要大于 0')
    if (priceCents < 0) reasons.push('单价不能为负数')
    if (reasons.length > 0) {
      problems.push(`第 ${index + 1} 行：${reasons.join('；')}`)
      return
    }

    items.push({
      brand,
      species,
      grade,
      remark,
      quantity,
      unit_price_cents: priceCents,
      amount_cents: Math.round(quantity * priceCents),
    })
  })
  return { items, problems }
}

/** 明细合计（分） */
const itemsTotalCents = (items) =>
  items.reduce((sum, item) => sum + item.amount_cents, 0)

/** 把合同明细整体换掉 */
function replaceContractItems(contractId, items) {
  deleteContractItems.run(contractId)
  for (const item of items) {
    insertContractItem.run({ ...item, contract_id: contractId })
  }
}

function todayLocal() {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** 只收 PDF：按扩展名 + MIME 双保险 */
function isPdf(file) {
  if (!file) return false
  const name = String(file.originalname ?? '').toLowerCase()
  const type = String(file.mimetype ?? '').toLowerCase()
  return name.endsWith('.pdf') || type === 'application/pdf'
}

/** 存盘文件名：合同号 + 随机后缀，避免重名覆盖 */
function storedFileName(contractNo) {
  const safe = contractNo.replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 60)
  const random = Math.random().toString(36).slice(2, 8)
  return `${safe}-${Date.now()}-${random}.pdf`
}

function writeFile(contractNo, file) {
  const name = storedFileName(contractNo)
  fs.writeFileSync(path.join(contractDir, name), file.buffer)
  return name
}

function removeFile(name) {
  if (!name) return
  try {
    fs.unlinkSync(path.join(contractDir, name))
  } catch {
    // 文件已经不在就算了
  }
}

const toApi = (row) => ({
  id: row.id,
  contract_no: row.contract_no,
  title: row.title ?? '',
  partner: row.partner ?? '',
  sign_date: row.sign_date ?? '',
  amount: fromCents(row.amount_cents),
  remark: row.remark ?? '',
  file_original: row.file_original ?? '',
  file_size: row.file_size ?? 0,
  has_file: Boolean(row.file_name),
  created_at: row.created_at,
})

/* ---------- 列表 ---------- */

router.get('/', (req, res) => {
  const conditions = [`deleted_at IS NULL`]
  const params = []

  const like = (value) => {
    const text = String(value ?? '').trim()
    return text ? `%${text}%` : ''
  }

  const keyword = like(req.query.keyword)
  if (keyword) {
    conditions.push(`(contract_no LIKE ? OR title LIKE ?)`)
    params.push(keyword, keyword)
  }

  const partner = like(req.query.partner)
  if (partner) {
    conditions.push(`partner LIKE ?`)
    params.push(partner)
  }

  if (req.query.date_from) {
    conditions.push(`sign_date >= ?`)
    params.push(String(req.query.date_from))
  }
  if (req.query.date_to) {
    conditions.push(`sign_date <= ?`)
    params.push(String(req.query.date_to))
  }

  const where = `WHERE ${conditions.join(' AND ')}`
  const total = Number(
    db.prepare(`SELECT COUNT(*) AS total FROM contracts ${where}`).get(...params)
      ?.total ?? 0,
  )
  const { limit, offset } = pageParams(req.query)

  const rows = db
    .prepare(
      `SELECT * FROM contracts
        ${where}
        ORDER BY sign_date DESC, id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset)
    .map((row) => ({
      ...toApi(row),
      // 明细的总数量（件），列表上直接能看出这单订了多少
      total_qty: roundTo(
        db
          .prepare(
            `SELECT COALESCE(SUM(quantity), 0) AS qty FROM contract_items WHERE contract_id = ?`,
          )
          .get(row.id)?.qty ?? 0,
        3,
      ),
    }))

  res.json({ total, limit, offset, rows })
})

/* ---------- 下拉选项（入库单填合同号时用） ---------- */

router.get('/options', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, contract_no, title, partner
         FROM contracts
        WHERE deleted_at IS NULL
        ORDER BY sign_date DESC, id DESC
        LIMIT 200`,
    )
    .all()

  res.json(
    rows.map((row) => ({
      id: row.id,
      contract_no: row.contract_no,
      title: row.title ?? '',
      partner: row.partner ?? '',
    })),
  )
})

/* ---------- 选合同大页面（采购入库「关联采购合同」用） ---------- */

/**
 * 一行一个合同，带上「这个合同已经入了多少」——光看合同号选不出来，
 * 得知道哪张还没入完、哪张已经全入了。
 */
const pickerSql = (where) => `
  SELECT ct.id, ct.contract_no, ct.title, ct.partner, ct.sign_date, ct.amount_cents,
         (SELECT ROUND(COALESCE(SUM(quantity), 0), 3) FROM contract_items ci
           WHERE ci.contract_id = ct.id)                                 AS total_qty,
         (SELECT GROUP_CONCAT(DISTINCT ci2.species) FROM contract_items ci2
           WHERE ci2.contract_id = ct.id)                                AS species_text,
         (SELECT GROUP_CONCAT(DISTINCT ci3.brand) FROM contract_items ci3
           WHERE ci3.contract_id = ct.id)                                AS brand_text,
         (SELECT COUNT(*) FROM inbound_orders o
           WHERE o.contract_no = ct.contract_no AND o.deleted_at IS NULL) AS in_orders,
         (SELECT ROUND(COALESCE(SUM(i.bundles), 0), 0)
            FROM order_items i
            JOIN inbound_orders o4 ON o4.id = i.order_id
           WHERE o4.contract_no = ct.contract_no AND o4.deleted_at IS NULL
             AND i.deleted_at IS NULL AND i.order_type = 'in')           AS in_bundles,
         (SELECT ROUND(COALESCE(SUM(i.cubic), 0), 4)
            FROM order_items i
            JOIN inbound_orders o2 ON o2.id = i.order_id
           WHERE o2.contract_no = ct.contract_no AND o2.deleted_at IS NULL
             AND i.deleted_at IS NULL AND i.order_type = 'in')            AS in_cubic,
         (SELECT ROUND(COALESCE(SUM(COALESCE(i.amount_cents, ROUND(i.amount * 100))), 0) / 100.0, 2)
            FROM order_items i
            JOIN inbound_orders o3 ON o3.id = i.order_id
           WHERE o3.contract_no = ct.contract_no AND o3.deleted_at IS NULL
             AND i.deleted_at IS NULL AND i.order_type = 'in')            AS in_amount
    FROM contracts ct
   WHERE ct.deleted_at IS NULL ${where}
   ORDER BY ct.sign_date DESC, ct.id DESC
`

router.get('/picker', (req, res) => {
  const conditions = []
  const params = []

  const text = String(req.query.keyword ?? '').trim()
  if (text) {
    conditions.push(`AND (ct.contract_no LIKE ? OR ct.title LIKE ? OR ct.partner LIKE ?)`)
    params.push(`%${text}%`, `%${text}%`, `%${text}%`)
  }
  const partner = String(req.query.partner ?? '').trim()
  if (partner) {
    conditions.push(`AND ct.partner LIKE ?`)
    params.push(`%${partner}%`)
  }

  const where = conditions.join(' ')
  const total = Number(
    db
      .prepare(
        `SELECT COUNT(*) AS total FROM contracts ct
          WHERE ct.deleted_at IS NULL ${where}`,
      )
      .get(...params)?.total ?? 0,
  )
  const { limit, offset } = pageParams(req.query)

  const rows = db
    .prepare(`${pickerSql(where)} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset)
    .map((row) => ({
      id: row.id,
      contract_no: row.contract_no,
      title: row.title ?? '',
      partner: row.partner ?? '',
      sign_date: row.sign_date ?? '',
      amount: fromCents(row.amount_cents),
      total_qty: roundTo(row.total_qty ?? 0, 3),
      species_text: row.species_text ?? '',
      brand_text: row.brand_text ?? '',
      in_bundles: row.in_bundles ?? 0,
      in_orders: row.in_orders ?? 0,
      in_cubic: roundTo(row.in_cubic ?? 0, 4),
      in_amount: roundTo(row.in_amount ?? 0, 2),
      /** 未到货方数 = 合同总立方 − 已经入库的立方；状态按这个判断 */
      left_qty: roundTo(
        Math.max(0, (row.total_qty ?? 0) - (row.in_cubic ?? 0)),
        3,
      ),
      left_cubic: roundTo(
        Math.max(0, (row.total_qty ?? 0) - (row.in_cubic ?? 0)),
        4,
      ),
      status:
        (row.total_qty ?? 0) <= 0
          ? '未填明细'
          : (row.in_cubic ?? 0) <= 0
            ? '未发货'
            : (row.in_cubic ?? 0) >= (row.total_qty ?? 0)
              ? '全部发货'
              : '部分发货',
      // 关联单号：这张合同已经开过哪几张入库单，点一下能跳过去改
      orders: db
        .prepare(
          `SELECT id, order_no, order_date FROM inbound_orders
            WHERE contract_no = ? AND deleted_at IS NULL
            ORDER BY id DESC LIMIT 20`,
        )
        .all(row.contract_no)
        .map((order) => ({
          id: order.id,
          order_no: order.order_no,
          order_date: order.order_date ?? '',
        })),
    }))

  res.json({ total, limit, offset, rows })
})

/* ---------- 详情 ---------- */

router.get('/:id', (req, res) => {
  const id = Number(req.params.id)
  const row = db
    .prepare(`SELECT * FROM contracts WHERE id = ? AND deleted_at IS NULL`)
    .get(id)

  if (!row) return res.status(404).json({ error: '合同不存在' })
  res.json({
    ...toApi(row),
    items: listContractItems.all(id).map(itemToApi),
  })
})

/* ---------- 打开 PDF ---------- */

router.get('/:id/file', (req, res) => {
  const id = Number(req.params.id)
  const row = db
    .prepare(`SELECT * FROM contracts WHERE id = ? AND deleted_at IS NULL`)
    .get(id)

  if (!row || !row.file_name) {
    return res.status(404).json({ error: '合同文件不存在' })
  }

  const filePath = path.join(contractDir, row.file_name)
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '合同文件已丢失，请重新上传' })
  }

  // inline：浏览器里直接预览 PDF，而不是下载
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader(
    'Content-Disposition',
    `inline; filename*=UTF-8''${encodeURIComponent(row.file_original || `${row.contract_no}.pdf`)}`,
  )
  fs.createReadStream(filePath).pipe(res)
})

/* ---------- 新增 ---------- */

const insertContract = db.prepare(
  `INSERT INTO contracts
     (contract_no, title, partner, sign_date, amount_cents, remark,
      file_name, file_original, file_size)
   VALUES
     (@contract_no, @title, @partner, @sign_date, @amount_cents, @remark,
      @file_name, @file_original, @file_size)`,
)

router.post('/', requireCap('contract.write'), upload.single('file'), (req, res) => {
  const body = req.body ?? {}
  const contractNo = String(body.contract_no ?? '').trim()
  const title = String(body.title ?? '').trim()
  const partner = String(body.partner ?? '').trim()
  const signDate = body.sign_date ? String(body.sign_date) : todayLocal()
  const remark = String(body.remark ?? '').trim()
  let amountCents = toCents(body.amount)

  // 明细填了就以明细合计为准（合同金额 = Σ 数量 × 单价）
  const rawItems = readRawItems(body)
  let items = []
  if (rawItems) {
    const parsed = normalizeContractItems(rawItems)
    if (parsed.problems.length > 0) {
      return res.status(400).json({ error: parsed.problems.join('\n') })
    }
    items = parsed.items
    if (items.length > 0) amountCents = itemsTotalCents(items)
  }

  if (!contractNo) return res.status(400).json({ error: '合同号不能为空' })
  // PDF 是选填：先建档、后补文件也行；只有真传了才校验格式
  if (req.file && !isPdf(req.file)) {
    return res.status(400).json({ error: '合同文件必须是 PDF 格式' })
  }
  if (amountCents < 0) return res.status(400).json({ error: '金额不能为负数' })

  const exists = db
    .prepare(`SELECT id FROM contracts WHERE contract_no = ? AND deleted_at IS NULL`)
    .get(contractNo)
  if (exists) return res.status(400).json({ error: `合同号 ${contractNo} 已存在` })

  let fileName = ''
  try {
    fileName = req.file ? writeFile(contractNo, req.file) : ''
    insertContract.run({
      contract_no: contractNo,
      title: title || null,
      partner: partner || null,
      sign_date: signDate,
      amount_cents: amountCents,
      remark: remark || null,
      file_name: fileName || null,
      file_original: req.file?.originalname ?? null,
      file_size: req.file?.size ?? 0,
    })
    if (rawItems) {
      const row = db
        .prepare(`SELECT id FROM contracts WHERE contract_no = ? AND deleted_at IS NULL`)
        .get(contractNo)
      if (row?.id) replaceContractItems(row.id, items)
    }
    res.json({ ok: true, contract_no: contractNo })
  } catch (err) {
    removeFile(fileName)
    if (String(err.message).includes('UNIQUE')) {
      return res.status(400).json({ error: `合同号 ${contractNo} 已存在` })
    }
    res.status(500).json({ error: err.message })
  }
})

/* ---------- 修改（可以只改信息，也可以换文件） ---------- */

const getContractStmt = db.prepare(
  `SELECT * FROM contracts WHERE id = ? AND deleted_at IS NULL`,
)
const updateContractStmt = db.prepare(
  `UPDATE contracts
      SET contract_no = ?, title = ?, partner = ?, sign_date = ?,
          amount_cents = ?, remark = ?,
          file_name = ?, file_original = ?, file_size = ?
    WHERE id = ? AND deleted_at IS NULL`,
)

router.put('/:id', requireCap('contract.write'), upload.single('file'), (req, res) => {
  const id = Number(req.params.id)
  const current = getContractStmt.get(id)
  if (!current) return res.status(404).json({ error: '合同不存在' })

  const body = req.body ?? {}
  const contractNo = String(body.contract_no ?? '').trim()
  const title = String(body.title ?? '').trim()
  const partner = String(body.partner ?? '').trim()
  const signDate = body.sign_date ? String(body.sign_date) : current.sign_date
  const remark = String(body.remark ?? '').trim()
  let amountCents = toCents(body.amount)

  // 明细填了就以明细合计为准
  const rawItems = readRawItems(body)
  let items = []
  if (rawItems) {
    /**
     * 看不到金额的角色（业务员）改合同时看不到原单价，
     * 表单里那一列是空的 —— 直接存回去会把整张合同的金额清成 0。
     * 这里按「品牌 + 品名 + 等级」把能对上的行原价补回来。
     */
    const oldItems = listContractItems.all(id)
    const parsed = normalizeContractItems(
      keepPricesFrom(rawItems, oldItems, {
        keyOf: contractItemKey,
        priceOf: (row) => Number(row.unit_price_cents ?? 0),
      }),
    )
    if (parsed.problems.length > 0) {
      return res.status(400).json({ error: parsed.problems.join('\n') })
    }
    items = parsed.items
    if (items.length > 0) amountCents = itemsTotalCents(items)
  }

  if (!contractNo) return res.status(400).json({ error: '合同号不能为空' })
  if (amountCents < 0) return res.status(400).json({ error: '金额不能为负数' })
  if (req.file && !isPdf(req.file)) {
    return res.status(400).json({ error: '请上传 PDF 格式的合同文件' })
  }

  const duplicate = db
    .prepare(
      `SELECT id FROM contracts
        WHERE contract_no = ? AND deleted_at IS NULL AND id <> ?`,
    )
    .get(contractNo, id)
  if (duplicate) return res.status(400).json({ error: `合同号 ${contractNo} 已存在` })

  let fileName = current.file_name
  let fileOriginal = current.file_original
  let fileSize = current.file_size
  let newFile = ''

  try {
    if (req.file) {
      newFile = writeFile(contractNo, req.file)
      fileName = newFile
      fileOriginal = req.file.originalname
      fileSize = req.file.size
    }

    updateContractStmt.run(
      contractNo,
      title || null,
      partner || null,
      signDate,
      amountCents,
      remark || null,
      fileName,
      fileOriginal,
      fileSize,
      id,
    )

    // 换了文件才删旧的，避免更新失败把原文件弄丢
    if (newFile && current.file_name) removeFile(current.file_name)
    if (rawItems) replaceContractItems(id, items)
    res.json({ ok: true, contract_no: contractNo })
  } catch (err) {
    removeFile(newFile)
    if (String(err.message).includes('UNIQUE')) {
      return res.status(400).json({ error: `合同号 ${contractNo} 已存在` })
    }
    res.status(500).json({ error: err.message })
  }
})

/* ---------- 删除（软删除，保留文件） ---------- */

router.delete('/:id', requireCap('contract.write'), (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '合同 ID 不合法' })
  }

  const result = db
    .prepare(
      `UPDATE contracts SET deleted_at = datetime('now', 'localtime')
        WHERE id = ? AND deleted_at IS NULL`,
    )
    .run(id)

  if (result.changes === 0) {
    return res.status(404).json({ error: '合同不存在' })
  }
  res.json({ ok: true })
})

export default router
