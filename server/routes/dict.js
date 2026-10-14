import express from 'express'
import { db } from '../db.js'
import { requireCap } from '../middleware/permissions.js'

const router = express.Router()

/** 目前只有两类：品名（木材名称）、等级 */
const KINDS = { species: '品名', grade: '等级' }

const toApi = (row) => ({ id: row.id, kind: row.kind, name: row.name })

const listByKind = db.prepare(
  `SELECT * FROM dict_items WHERE kind = ? ORDER BY sort_order, id`,
)
const listAll = db.prepare(
  `SELECT * FROM dict_items ORDER BY kind, sort_order, id`,
)
const findByName = db.prepare(
  `SELECT * FROM dict_items WHERE kind = ? AND name = ?`,
)
const findById = db.prepare(`SELECT * FROM dict_items WHERE id = ?`)
const maxOrder = db.prepare(
  `SELECT COALESCE(MAX(sort_order), 0) AS m FROM dict_items WHERE kind = ?`,
)

/**
 * 常用项列表：录单时的下拉候选。
 * 不带参数返回 { species: [...], grade: [...] }；带 ?kind= 只返回那一类。
 */
router.get('/', (req, res) => {
  const kind = String(req.query.kind ?? '').trim()
  const rows = kind ? listByKind.all(kind) : listAll.all()

  const result = { species: [], grade: [] }
  for (const row of rows) {
    if (result[row.kind]) result[row.kind].push(toApi(row))
  }
  res.json(result)
})

/** 新增一个常用项（同类同名会去重） */
router.post('/', requireCap('dict.write'), (req, res) => {
  const kind = String(req.body?.kind ?? '').trim()
  const name = String(req.body?.name ?? '').trim()

  if (!KINDS[kind]) {
    return res
      .status(400)
      .json({ error: '类型不合法：只能是 species（品名）或 grade（等级）' })
  }
  if (!name) return res.status(400).json({ error: '名称不能为空' })
  if (name.length > 40) {
    return res.status(400).json({ error: '名称太长了，请控制在 40 个字以内' })
  }
  if (findByName.get(kind, name)) {
    return res.status(400).json({ error: `${name} 已经在常用${KINDS[kind]}里了` })
  }

  const next = Number(maxOrder.get(kind)?.m ?? 0) + 1
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO dict_items (kind, name, sort_order) VALUES (?, ?, ?)`)
    .run(kind, name, next)

  res.json({ ok: true, id: Number(lastInsertRowid), kind, name })
})

/** 改名（排序位置不变） */
router.put('/:id', requireCap('dict.write'), (req, res) => {
  const id = Number(req.params.id)
  const row = Number.isInteger(id) && id > 0 ? findById.get(id) : undefined
  if (!row) return res.status(404).json({ error: '这一项不存在' })

  const name = String(req.body?.name ?? '').trim()
  if (!name) return res.status(400).json({ error: '名称不能为空' })
  if (name.length > 40) {
    return res.status(400).json({ error: '名称太长了，请控制在 40 个字以内' })
  }

  const duplicate = findByName.get(row.kind, name)
  if (duplicate && duplicate.id !== id) {
    return res
      .status(400)
      .json({ error: `${name} 已经在常用${KINDS[row.kind]}里了` })
  }

  db.prepare(`UPDATE dict_items SET name = ? WHERE id = ?`).run(name, id)
  res.json({ ok: true, id, kind: row.kind, name })
})

/** 删除一个常用项（只影响下拉候选，不动已录的单据） */
router.delete('/:id', requireCap('dict.write'), (req, res) => {
  const id = Number(req.params.id)
  const row = Number.isInteger(id) && id > 0 ? findById.get(id) : undefined
  if (!row) return res.status(404).json({ error: '这一项不存在' })

  db.prepare(`DELETE FROM dict_items WHERE id = ?`).run(id)
  res.json({ ok: true })
})

export default router
