import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import multer from 'multer'
import { db, storageDir } from '../db.js'
import { toCents, fromCents } from '../utils/cubic.js'
import { pageParams } from '../utils/paging.js'

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
    .map(toApi)

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
         (SELECT COUNT(*) FROM inbound_orders o
           WHERE o.contract_no = ct.contract_no AND o.deleted_at IS NULL) AS in_orders,
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
      in_orders: row.in_orders ?? 0,
      in_cubic: roundTo(row.in_cubic ?? 0, 4),
      in_amount: roundTo(row.in_amount ?? 0, 2),
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
  res.json(toApi(row))
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

router.post('/', upload.single('file'), (req, res) => {
  const body = req.body ?? {}
  const contractNo = String(body.contract_no ?? '').trim()
  const title = String(body.title ?? '').trim()
  const partner = String(body.partner ?? '').trim()
  const signDate = body.sign_date ? String(body.sign_date) : todayLocal()
  const remark = String(body.remark ?? '').trim()
  const amountCents = toCents(body.amount)

  if (!contractNo) return res.status(400).json({ error: '合同号不能为空' })
  if (!isPdf(req.file)) {
    return res.status(400).json({ error: '请上传 PDF 格式的合同文件' })
  }
  if (amountCents < 0) return res.status(400).json({ error: '金额不能为负数' })

  const exists = db
    .prepare(`SELECT id FROM contracts WHERE contract_no = ? AND deleted_at IS NULL`)
    .get(contractNo)
  if (exists) return res.status(400).json({ error: `合同号 ${contractNo} 已存在` })

  let fileName = ''
  try {
    fileName = writeFile(contractNo, req.file)
    insertContract.run({
      contract_no: contractNo,
      title: title || null,
      partner: partner || null,
      sign_date: signDate,
      amount_cents: amountCents,
      remark: remark || null,
      file_name: fileName,
      file_original: req.file.originalname,
      file_size: req.file.size,
    })
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

router.put('/:id', upload.single('file'), (req, res) => {
  const id = Number(req.params.id)
  const current = getContractStmt.get(id)
  if (!current) return res.status(404).json({ error: '合同不存在' })

  const body = req.body ?? {}
  const contractNo = String(body.contract_no ?? '').trim()
  const title = String(body.title ?? '').trim()
  const partner = String(body.partner ?? '').trim()
  const signDate = body.sign_date ? String(body.sign_date) : current.sign_date
  const remark = String(body.remark ?? '').trim()
  const amountCents = toCents(body.amount)

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

router.delete('/:id', (req, res) => {
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
