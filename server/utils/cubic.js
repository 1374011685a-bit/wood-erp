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
 * 混装包（一包多段长度）的总立方。
 *
 * 每件立方 = Σ(厚 × 宽 × 该段长度 × 该段片数) ÷ 1e6，再乘件数。
 * 单段时和 calcCubic(th, w, len, pieces, bundles) 完全等价
 * （先把每段算出去除再相加会引入多次四舍五入，所以这里只在最后取整）。
 *
 * @param {number} thickness 厚度（mm）
 * @param {number} width 宽度（mm）
 * @param {Array<{length:number,pieces:number}>} specs 各段规格
 * @param {number} [bundles=1] 件数
 */
export function calcCubicOfSpecs(thickness, width, specs, bundles = 1) {
  const list = Array.isArray(specs) && specs.length > 0 ? specs : [{ length: 0, pieces: 0 }]
  const perBundle = list.reduce(
    (sum, spec) => sum + (thickness * width * Number(spec.length) * Number(spec.pieces)) / 1000000,
    0,
  )
  return Number((perBundle * bundles).toFixed(4))
}

/**
 * 计算金额，保留 2 位小数
 *
 * 注意：库里金额以「整数分」为唯一真相（见 calcAmountCents），
 * 这个函数只用于把分转回元做展示，或者给不关心精度的旧调用兜底。
 * @param {number} cubic 立方数
 * @param {number} unitPrice 单价
 * @returns {number} 金额，保留 2 位小数
 */
export function calcAmount(cubic, unitPrice) {
  const amount = cubic * unitPrice
  return Number(amount.toFixed(2))
}

/* ---------- 金额：统一用「整数分」计算和存储 ---------- */

/**
 * 元 → 分（四舍五入到整数分）
 * @param {number|string} yuan 以元为单位的金额（前端传上来的单价）
 * @returns {number} 整数分
 */
export function toCents(yuan) {
  const num = Number(yuan)
  if (!Number.isFinite(num)) return 0
  return Math.round(num * 100)
}

/**
 * 分 → 元（保留 2 位小数的数值）
 * @param {number} cents 整数分
 * @returns {number} 以元为单位的金额
 */
export function fromCents(cents) {
  const num = Number(cents)
  if (!Number.isFinite(num)) return 0
  return Number((num / 100).toFixed(2))
}

/**
 * 金额（分）= 立方数 × 单价（分），四舍五入到分
 * @param {number} cubic 立方数
 * @param {number} unitPriceCents 单价（整数分）
 * @returns {number} 金额（整数分）
 */
export function calcAmountCents(cubic, unitPriceCents) {
  const c = Number(cubic)
  const p = Number(unitPriceCents)
  if (!Number.isFinite(c) || !Number.isFinite(p)) return 0
  return Math.round(c * p)
}
