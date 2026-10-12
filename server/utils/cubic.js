/**
 * 木材立方计算
 *
 * 单位约定：
 * - thickness 厚度：毫米（mm）
 * - width     宽度：毫米（mm）
 * - length    长度：米（m）
 * - pieces    片数：每件片数
 * - bundles   件数
 *
 * 公式：立方数 = 厚度 × 宽度 × 长度 × 片数 × 件数 ÷ 1,000,000
 */

/**
 * 计算立方数，保留 4 位小数
 * @param {number} thickness 厚度（mm）
 * @param {number} width 宽度（mm）
 * @param {number} length 长度（m）
 * @param {number} [pieces=1] 片数（每件片数）
 * @param {number} [bundles=1] 件数
 * @returns {number} 立方数，保留 4 位小数
 */
export function calcCubic(thickness, width, length, pieces = 1, bundles = 1) {
  const cubic = (thickness * width * length * pieces * bundles) / 1000000
  return Number(cubic.toFixed(4))
}

/**
 * 计算金额，保留 2 位小数
 * @param {number} cubic 立方数
 * @param {number} unitPrice 单价
 * @returns {number} 金额，保留 2 位小数
 */
export function calcAmount(cubic, unitPrice) {
  const amount = cubic * unitPrice
  return Number(amount.toFixed(2))
}
