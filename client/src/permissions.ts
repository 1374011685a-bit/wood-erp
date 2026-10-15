/**
 * 前端权限表 —— server/permissions.js 的镜像。
 *
 * ⚠️ 这里只负责「把不该给用户看的按钮和菜单藏起来」，**不是安全边界**。
 * 真正的拦截在后端：看不到金额的角色，接口响应里压根就没有金额字段，
 * 前端就算硬把列显示出来也只会看到空白。
 *
 * 两边的 CAPS 要保持一致。改权限时先改后端那份，再同步这份。
 */

export type Role = 'admin' | 'finance' | 'sales' | 'warehouse' | 'viewer'

export const ROLES: Role[] = ['admin', 'finance', 'sales', 'warehouse', 'viewer']

export const ROLE_LABELS: Record<Role, string> = {
  admin: '管理员',
  finance: '财务',
  sales: '业务员',
  warehouse: '仓管',
  viewer: '只读',
}

type Cap =
  | 'money'
  | 'user.admin'
  | 'inbound.write'
  | 'outbound.write'
  | 'contract.write'
  | 'bale.write'
  | 'shipment.write'
  | 'repack.write'
  | 'count.write'
  | 'settlement.write'
  | 'dict.write'
  | 'recycle.write'

const CAPS: Record<Cap, Role[]> = {
  money: ['admin', 'finance'],
  'user.admin': ['admin'],
  'inbound.write': ['admin', 'finance', 'sales', 'warehouse'],
  'outbound.write': ['admin', 'finance', 'sales', 'warehouse'],
  'contract.write': ['admin', 'finance', 'sales'],
  'bale.write': ['admin', 'finance', 'warehouse'],
  'shipment.write': ['admin', 'finance', 'sales', 'warehouse'],
  'repack.write': ['admin', 'finance', 'warehouse'],
  'count.write': ['admin', 'finance', 'warehouse'],
  'settlement.write': ['admin', 'finance'],
  'dict.write': ['admin', 'finance'],
  'recycle.write': ['admin', 'finance'],
}

/** 这个角色有没有这个能力 */
export const can = (role: Role, cap: Cap) => CAPS[cap].includes(role)

/** 这个角色能不能看金额。看不到时，后端也不会返回金额字段 */
export const seesMoney = (role: Role) => can(role, 'money')

/**
 * 哪些角色能进哪些页面。
 * 菜单渲染、已打开的标签、路由本身都按这张表过滤。
 */
export const NAV_ALLOW: Record<string, Role[]> = {
  '/': ['admin', 'finance', 'sales', 'warehouse', 'viewer'],
  '/contracts': ['admin', 'finance', 'sales', 'warehouse', 'viewer'],
  '/inbound': ['admin', 'finance', 'sales', 'warehouse', 'viewer'],
  '/bales': ['admin', 'finance', 'sales', 'warehouse', 'viewer'],
  '/outbound': ['admin', 'finance', 'sales', 'warehouse', 'viewer'],
  '/stock': ['admin', 'finance', 'sales', 'warehouse', 'viewer'],
  '/records': ['admin', 'finance', 'sales', 'warehouse', 'viewer'],
  // 盘点 / 改包是重操作页，只读角色进来也没事干
  '/count': ['admin', 'finance', 'warehouse'],
  '/repack': ['admin', 'finance', 'warehouse'],
  // 对账页整页都是金额，业务员 / 仓管 / 只读都进不去
  '/settlement': ['admin', 'finance'],
  '/dict': ['admin', 'finance'],
  '/recycle': ['admin', 'finance'],
  '/users': ['admin'],
  // AI 助手：所有登录角色都能用
  '/ai': ['admin', 'finance', 'sales', 'warehouse', 'viewer'],
  // 打印标签页不挂菜单，但路由要能进（从码单列表点过来的）
  '/label/print': ['admin', 'finance', 'sales', 'warehouse'],
}

/** 这个角色能不能进这个路径（不在表里的默认放行，避免新页面忘配就进不去） */
export const canVisit = (role: Role, path: string) => {
  const base = path.replace(/\/new$/, '')
  const allow = NAV_ALLOW[path] ?? NAV_ALLOW[base]
  return allow ? allow.includes(role) : true
}

/* ---------- 登录态里带的角色 ---------- */

const ROLE_KEY = 'wood-erp-role'

export function getStoredRole(): Role {
  const raw = localStorage.getItem(ROLE_KEY)
  return ROLES.includes(raw as Role) ? (raw as Role) : 'viewer'
}

export function setStoredRole(role: Role) {
  localStorage.setItem(ROLE_KEY, role)
}

export function clearStoredRole() {
  localStorage.removeItem(ROLE_KEY)
}
