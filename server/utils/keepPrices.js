/**
 * 「看不到金额的角色」编辑已有单据时，保住原来的单价。
 *
 * 背景：这类角色的详情接口拿不到单价（后端故意不返回，见 middleware/permissions.js），
 * 所以编辑表单里那一列是空的。如果原样存回去，金额会被清成 0 —— 那是**数据损坏**，
 * 而且是悄悄发生的，最不能接受。
 *
 * 做法：新明细里「没填单价」的行，如果能在原明细里**唯一**匹配到同样的一行，
 * 就沿用它的原价。匹配键用系统里其它价格逻辑同一套口径
 * （品名 + 等级 + 规格 + 片数，见 repacks.js / count.js / outbound.js）。
 *
 * 匹配不到（真正新增的行）或者匹配到多行（同一规格有两行不同价，不敢猜）就原样返回，
 * 交给后面的字段校验去拦。**宁可报错，也不猜一个价。**
 *
 * @param {Array<object>} rawItems 前端传来的原始明细
 * @param {Array<object>} oldRows  库里原来的明细（要带单价，单位分）
 * @param {(row: object) => string} keyOf 取匹配键
 * @param {(row: object) => number} priceOf 取单价（**分**）
 */
export function keepPricesFrom(rawItems, oldRows, { keyOf, priceOf }) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) return rawItems
  if (!Array.isArray(oldRows) || oldRows.length === 0) return rawItems

  // 同一个键出现几次要数清楚：出现 2 次说明这一规格有两行、价格未必一样，不能猜
  const buckets = new Map()
  for (const row of oldRows) {
    const cents = Math.round(Number(priceOf(row) ?? 0))
    if (!(cents > 0)) continue
    const key = keyOf(row)
    const list = buckets.get(key)
    if (list) list.push(cents)
    else buckets.set(key, [cents])
  }

  return rawItems.map((raw) => {
    const given = Number(raw?.unit_price)
    // 前端填了有效单价（> 0）：尊重用户的输入
    if (Number.isFinite(given) && given > 0) return raw
    // 前端给的是空 / 0 / undefined：这才是「看不到金额，没法填」的情况
    const list = buckets.get(keyOf(raw)) ?? []
    if (list.length !== 1) return raw
    return { ...raw, unit_price: list[0] / 100 }
  })
}

/** 出入库明细的匹配键：品名 + 等级 + 厚 + 宽 + 长 + 片数 */
export const orderItemKey = (row) =>
  [
    String(row?.species ?? '').trim(),
    String(row?.grade ?? '').trim(),
    Number(row?.thickness),
    Number(row?.width),
    Number(row?.length),
    Number(row?.pieces),
  ].join('|')

/** 合同明细的匹配键：品牌 + 品名 + 等级（改合同主要是改数量，规格不在合同上） */
export const contractItemKey = (row) =>
  [
    String(row?.brand ?? '').trim(),
    String(row?.species ?? '').trim(),
    String(row?.grade ?? '').trim(),
  ].join('|')
