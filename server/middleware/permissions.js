import { can, seesMoney } from '../permissions.js'

/**
 * 业务权限与金额过滤。
 *
 * 两道门：
 *   1. requireCap(cap) —— 这个角色能不能调这个接口；
 *   2. moneyGuard      —— 看不到金额的角色，响应里直接把金额字段删掉。
 *
 * 为什么金额是「拦 res.json」而不是「每个接口自己裁剪」：
 *   全站 60+ 个接口里 20 来个带金额，而且大量嵌在 rows[] / items[] / sums 里。
 *   逐个改写不仅量大，以后新加接口一定漏。拦在响应出口上是「默认安全」——
 *   新接口只要走 res.json 就自动被覆盖，想漏都难。
 */

/** 按能力放行 */
export function requireCap(cap) {
  return (req, res, next) => {
    if (can(req.user?.role, cap)) return next()
    return res.status(403).json({ error: '你没有这个操作的权限，请联系管理员' })
  }
}

/**
 * 金额字段黑名单。
 *
 * 用「精确列名」而不是模糊正则：宁可漏掉新字段时被测试发现，
 * 也不要把某个同名的非金额字段（比如将来可能出现的 balance 库存余量）误删。
 * 新增金额字段时**必须**同步加到这里 —— 断言测试会兜底检查接口实测结果。
 */
const MONEY_KEYS = new Set([
  // 明细上的单价 / 金额
  'unit_price',
  'unit_price_cents',
  'amount',
  'amount_cents',
  'total_amount',
  // 单据合计（入库 / 出库 / 回收站 / 首页最近流水）
  'amount_before',
  'amount_after',
  'before_amount',
  'after_amount',
  'loss_amount',
  // 库存均价 / 合同 / 对账
  'avg_unit_price',
  'in_amount',
  'out_amount',
  'order_amount',
  'paid',
  'balance',
  'opening',
  'closing',
  'period_occurred',
  'period_paid',
  // 首页看板
  'total_stock_amount',
  'receivable_total',
  'payable_total',
  'today_in_amount',
  'today_out_amount',
  // 改包：多成本价候选（本身就是一份价格清单）
  'price_candidates',
])

/** 这个 key 是不是金额字段 */
export const isMoneyKey = (key) => MONEY_KEYS.has(key)

/**
 * 递归删掉金额字段。
 *
 * 就地改：这些对象都是本次请求现拼出来的（见各路由的 res.json 调用），
 * 没有跨请求复用，直接删比深拷贝一份更省。
 */
export function stripMoney(value) {
  if (Array.isArray(value)) {
    for (const item of value) stripMoney(item)
    return value
  }

  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (isMoneyKey(key)) {
        delete value[key]
        continue
      }
      stripMoney(value[key])
    }
  }

  return value
}

/**
 * 金额过滤中间件：看不到金额的角色，把响应体里的金额字段全删掉。
 *
 * 挂在 requireAuth 之后、业务路由之前，覆盖该前缀下所有走 res.json 的响应
 * （含写操作的回包，比如入库编辑返回的 amount_before / amount_after）。
 *
 * 注意：导出 Excel 走 res.end(buffer)，不经过这里，
 * 所以 routes/export.js 里必须自己按角色删列。
 */
export function moneyGuard(req, res, next) {
  if (seesMoney(req.user?.role)) return next()

  const originalJson = res.json.bind(res)
  res.json = (body) => originalJson(stripMoney(body))
  next()
}
