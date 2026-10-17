import type { ContractPickerRow } from '../api'

export type ContractStage = {
  label: '已录入' | '执行中' | '已完成'
  tone: 'neutral' | 'info' | 'success'
}

/**
 * 合同列表统一状态：
 * - 还没有任何入库：已录入
 * - 已经全部到货（件数和立方都满足）：已完成
 * - 其余：执行中
 */
export function contractStage(
  row: Pick<ContractPickerRow, 'in_bundles' | 'total_qty' | 'in_cubic' | 'left_cubic'>,
): ContractStage {
  const enteredQty = Number(row.in_bundles ?? 0)
  const totalQty = Number(row.total_qty ?? 0)
  const enteredCubic = Number(row.in_cubic ?? 0)
  const leftCubic = Number(row.left_cubic ?? 0)

  if (enteredQty <= 0 && enteredCubic <= 0.00005) {
    return { label: '已录入', tone: 'neutral' }
  }
  const qtyDone = totalQty > 0 && enteredQty >= totalQty
  const cubicDone = enteredCubic > 0 && leftCubic <= 0.00005
  if (qtyDone || cubicDone) {
    return { label: '已完成', tone: 'success' }
  }
  return { label: '执行中', tone: 'info' }
}
