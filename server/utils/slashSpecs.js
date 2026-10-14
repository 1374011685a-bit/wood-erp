/**
 * 混装包录入：一行里写多个长度。
 *
 *   长度 `1800/2100/2400`、片数 `17/30/247`
 *   → 这一包里有 3 段规格：(1.8m, 17片) (2.1m, 30片) (2.4m, 247片)
 *
 * 规则（和用户确认过的口径一致）：
 *   - 厚度、宽度只能填一个数（混装只按长度分）
 *   - 长度和片数**要么都只有一段，要么段数一样多**；
 *     只有一边有斜杠、或者段数不等，一律 400，绝不猜、绝不静默取第一段
 *
 * 长度单位：库里一直是「米」（列头写的 长度(m)，校验是 0~20m）。
 * 但实际录单时人习惯说「1800」这种毫米数，所以这里做一次识别：
 * **大于 20 的一律当毫米，除以 1000**。20 米以上没有木材，这个判断不会误伤。
 * 换算结果会在前端实时显示（1800 → 1.8 m），不是偷偷改。
 */

/** 库里长度的合法上限（米） */
const MAX_LENGTH_M = 20

/** 一段文本 → 米。> 20 视为毫米 */
export function toMeters(raw) {
  const num = Number(String(raw ?? '').trim())
  if (!Number.isFinite(num) || num <= 0) return NaN
  return num > MAX_LENGTH_M ? num / 1000 : num
}

/** 有没有用斜杠写多段；返回各段原文 */
function segments(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return null
  if (!text.includes('/')) return [text]
  return text.split('/').map((part) => part.trim())
}

/**
 * 把带斜杠的明细行展开成「一包多段规格」。
 *
 * 不展开成多行，而是给这一行挂一个 `specs: [{length, pieces}, ...]` ——
 * 因为「一包里几个规格」本来就是 bale_items 的语义（一包多行规格行），
 * 展开成多行反而会把它们拆成几个包（包号唯一性按行算）。
 *
 * @returns {{ items: object[], problems: string[] }}
 */
export function expandSlashSpecs(rawItems) {
  const problems = []

  const items = rawItems.map((item, index) => {
    const row = index + 1
    const thSegs = segments(item?.thickness)
    const wSegs = segments(item?.width)
    const lenSegs = segments(item?.length)
    const pcsSegs = segments(item?.pieces)

    if ((thSegs?.length ?? 0) > 1 || (wSegs?.length ?? 0) > 1) {
      problems.push(
        `第 ${row} 行：厚度和宽度只能填一个数。混装包是「同一厚度宽度、长度不同」，请只把长度写成 1800/2100/2400 这种`,
      )
      return item
    }

    const lenCount = lenSegs?.length ?? 0
    const pcsCount = pcsSegs?.length ?? 0

    // 普通的单规格行：原样放行，后面的字段校验照旧
    if (lenCount <= 1 && pcsCount <= 1) return item

    /**
     * 比的是**段数**，不是「有没有斜杠」——
     * 长度 3 段、片数 2 段时两边都有斜杠，只比标志位会漏过去，
     * 掉到下面按段校验，报出来的错就变成莫名其妙的「第 3 段片数 undefined」。
     */
    if (lenCount !== pcsCount) {
      problems.push(
        `第 ${row} 行：长度填了 ${Math.max(lenCount, 1)} 段、片数填了 ${Math.max(pcsCount, 1)} 段，两边要一样多。` +
          `比如长度 1800/2100/2400 就配片数 17/30/247`,
      )
      return item
    }

    if (lenSegs.length < 2) {
      problems.push(`第 ${row} 行：斜杠后面少了内容，请检查长度和片数`)
      return item
    }

    const specs = []
    for (let i = 0; i < lenSegs.length; i += 1) {
      const meters = toMeters(lenSegs[i])
      const pieces = Number(pcsSegs[i])

      if (!Number.isFinite(meters) || meters > MAX_LENGTH_M) {
        problems.push(
          `第 ${row} 行：第 ${i + 1} 段长度「${lenSegs[i]}」不对，要在 0~${MAX_LENGTH_M} 米之间`,
        )
      }
      if (!(Number.isInteger(pieces) && pieces > 0)) {
        problems.push(
          `第 ${row} 行：第 ${i + 1} 段片数「${pcsSegs[i]}」不对，要是大于 0 的整数`,
        )
      }
      specs.push({ length: meters, pieces })
    }

    return {
      ...item,
      specs,
      // 主字段取第一段（老代码读 length/pieces 的地方行为不变）
      length: specs[0].length,
      pieces: specs[0].pieces,
    }
  })

  return { items, problems }
}

/** 这一行要落几段规格（普通行就是 1） */
export const specsOf = (item) =>
  Array.isArray(item?.specs) && item.specs.length > 0
    ? item.specs
    : [{ length: Number(item?.length), pieces: Number(item?.pieces) }]
