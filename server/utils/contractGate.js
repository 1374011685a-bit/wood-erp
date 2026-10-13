import { db } from '../db.js'

const findByNo = db.prepare(
  `SELECT id, contract_no, partner FROM contracts
    WHERE contract_no = ? AND deleted_at IS NULL`,
)
const countAll = db.prepare(
  `SELECT COUNT(*) AS total FROM contracts WHERE deleted_at IS NULL`,
)

/**
 * 「有了合同才有到柜」：提单 / 柜上的合同号必须在合同档案里存在。
 *
 * 返回空字符串 = 通过；返回一段中文说明 = 不通过（路由直接 400 抛给前端）。
 * 传空合同号是允许的（老流程 / 还没归档的到货），不在这里拦。
 */
export function contractError(contractNo) {
  const no = String(contractNo ?? '').trim()
  if (!no) return ''
  if (findByNo.get(no)) return ''

  const total = Number(countAll.get()?.total ?? 0)
  if (total === 0) {
    return (
      `合同档案里还没有任何合同，不能建到柜。` +
      `请先到「合同」页新建合同 ${no}（含 PDF），再回来录提单 / 柜。`
    )
  }
  return (
    `合同号 ${no} 在合同档案里不存在。` +
    `请先到「合同」页新建这个合同，或在表单里从已有合同下拉中选择。`
  )
}

export default contractError
