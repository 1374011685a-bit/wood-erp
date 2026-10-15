/**
 * 权限的唯一真相源。
 *
 * 全系统只有这一张表决定「谁能干什么」：
 *   - 后端：中间件 requireCap / moneyGuard 读它；
 *   - 前端：client/src/permissions.ts 是这张表的镜像，只用来隐藏按钮和菜单。
 *
 * 改权限只改这里。前端那份是给人看的，真正拦得住的是这份。
 */

export const ROLES = ['admin', 'finance', 'sales', 'warehouse', 'viewer']

/** 角色中文名，给用户管理页和报错提示用 */
export const ROLE_LABELS = {
  admin: '管理员',
  finance: '财务',
  sales: '业务员',
  warehouse: '仓管',
  viewer: '只读',
}

export const isRole = (value) => ROLES.includes(String(value ?? ''))

/**
 * 能力 → 允许的角色。
 *
 * 命名约定：xxx.view 管「读」，xxx.write 管「写」。
 * 读和写分开，是因为同一个前缀里两边权限常常不一样
 * （业务员能看合同也能建合同，但不能删；仓管能看改包页但不能看金额）。
 */
export const CAPS = {
  /** 看金额。只有管理员的财务能看，其余角色后端直接不返回金额字段 */
  money: ['admin', 'finance'],

  /** 用户管理（开号 / 改角色 / 停用 / 重置密码）——只给管理员 */
  'user.admin': ['admin'],

  'home.view': ['admin', 'finance', 'sales', 'warehouse', 'viewer'],
  'inbound.view': ['admin', 'finance', 'sales', 'warehouse', 'viewer'],
  'inbound.write': ['admin', 'finance', 'sales', 'warehouse'],
  'outbound.view': ['admin', 'finance', 'sales', 'warehouse', 'viewer'],
  'outbound.write': ['admin', 'finance', 'sales', 'warehouse'],
  'stock.view': ['admin', 'finance', 'sales', 'warehouse', 'viewer'],
  'records.view': ['admin', 'finance', 'sales', 'warehouse', 'viewer'],
  'contract.view': ['admin', 'finance', 'sales', 'warehouse', 'viewer'],
  'contract.write': ['admin', 'finance', 'sales'],
  'bale.view': ['admin', 'finance', 'sales', 'warehouse', 'viewer'],
  /** 编辑 / 删除码单（改包号、删柜）：仓管在干这件事 */
  'bale.write': ['admin', 'finance', 'warehouse'],
  'shipment.view': ['admin', 'finance', 'sales', 'warehouse', 'viewer'],
  'shipment.write': ['admin', 'finance', 'sales', 'warehouse'],
  /** 改包：仓管能进能改，但看不到金额（金额由后端算，不返回） */
  'repack.view': ['admin', 'finance', 'warehouse'],
  'repack.write': ['admin', 'finance', 'warehouse'],
  'count.view': ['admin', 'finance', 'warehouse'],
  'count.write': ['admin', 'finance', 'warehouse'],
  /** 对账页整页都是金额，业务员 / 仓管 / 只读都进不去 */
  'settlement.view': ['admin', 'finance'],
  'settlement.write': ['admin', 'finance'],
  'dict.view': ['admin', 'finance', 'sales', 'warehouse', 'viewer'],
  'dict.write': ['admin', 'finance'],
  'recycle.view': ['admin', 'finance'],
  'recycle.write': ['admin', 'finance'],
  /** 导出明细数据。金额列在导出时按角色删，见 routes/export.js */
  'export.data': ['admin', 'finance', 'sales', 'warehouse', 'viewer'],

  /** AI 助手（DeepSeek）。先做成最简的一问一答，所有登录角色都能用 */
  'ai.chat': ['admin', 'finance', 'sales', 'warehouse', 'viewer'],
}

/** 这个角色有没有这个能力 */
export const can = (role, cap) => (CAPS[cap] ?? []).includes(String(role ?? ''))

/** 这个角色能不能看金额 */
export const seesMoney = (role) => can(role, 'money')
