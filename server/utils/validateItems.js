/**
 * 明细字段校验（入库 / 出库共用）
 *
 * 校验对象是 normalizeItems() 之后的明细，即真正要落库的那份数据。
 * 返回问题清单，空数组表示全部通过。
 */

const MAX_THICKNESS = 1000 // mm
const MAX_WIDTH = 1000 // mm
const MAX_LENGTH = 20 // m

/**
 * @param {Array<object>} items normalizeItems() 的产物
 * @param {{ requirePositiveCubic?: boolean }} [options]
 *        requirePositiveCubic：出库专用，该行立方必须大于 0
 * @returns {string[]} 例如 ["第 1 行：品名不能为空；厚度必须大于 0mm"]
 */
export function validateItems(items, { requirePositiveCubic = false } = {}) {
  const problems = []

  items.forEach((item, index) => {
    const reasons = []

    if (!item.species) {
      reasons.push('品名不能为空')
    }

    // grade 允许为空（normalizeItems 已 trim）

    if (item.thickness <= 0) {
      reasons.push('厚度必须大于 0mm')
    } else if (item.thickness > MAX_THICKNESS) {
      reasons.push(`厚度不能超过 ${MAX_THICKNESS}mm`)
    }

    if (item.width <= 0) {
      reasons.push('宽度必须大于 0mm')
    } else if (item.width > MAX_WIDTH) {
      reasons.push(`宽度不能超过 ${MAX_WIDTH}mm`)
    }

    /**
     * 长度 / 片数按「段」校验：混装包一行里有多段（长度 1800/2100/2400），
     * 每一段都要过关。单段的行等价于只校验一次。
     */
    const specs =
      Array.isArray(item.specs) && item.specs.length > 0
        ? item.specs
        : [{ length: item.length, pieces: item.pieces }]
    const multi = specs.length > 1

    specs.forEach((spec, seg) => {
      const tag = multi ? `第 ${seg + 1} 段 ` : ''
      if (!(spec.length > 0)) {
        reasons.push(`${tag}长度必须大于 0m`)
      } else if (spec.length > MAX_LENGTH) {
        reasons.push(`${tag}长度不能超过 ${MAX_LENGTH}m`)
      }
      if (!(Number.isInteger(spec.pieces) && spec.pieces > 0)) {
        reasons.push(`${tag}片数必须是大于 0 的整数`)
      }
    })

    if (!(Number.isInteger(item.bundles) && item.bundles > 0)) {
      reasons.push('件数必须是大于 0 的整数')
    }

    // 单价必填：金额是账面上要用的数，不能空着当 0
    if (!(item.unit_price > 0)) {
      reasons.push('单价必填，且必须大于 0')
    }

    // 出库额外要求：立方必须为正，挡住 0 / 负数出库
    if (requirePositiveCubic && !(item.cubic > 0)) {
      reasons.push('立方数必须大于 0（尺寸过小或数量为 0 时会出现）')
    }

    if (reasons.length > 0) {
      problems.push(`第 ${index + 1} 行：${reasons.join('；')}`)
    }
  })

  return problems
}
