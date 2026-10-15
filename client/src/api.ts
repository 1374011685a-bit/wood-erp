import { clearStoredRole, setStoredRole } from './permissions'
import type { Role } from './permissions'

/** 分页列表的统一返回结构 */
export type Paged<T> = {
  total: number
  limit: number
  offset: number
  rows: T[]
}

export type InboundItemPayload = {
  /** 品牌（选填）：只记不参与匹配，库存归组仍按 品名+等级+尺寸 */
  brand?: string
  species: string
  grade: string
  thickness: number
  width: number
  /** 长度：普通行是数字；混装包可以是「1800/2100/2400」这种多段写法 */
  length: number | string
  /** 片数：普通行是数字；混装包可以是「17/30/247」 */
  pieces: number | string
  bundles: number
  unit_price: number
  /** 包号列表（一个包号一个码单）；留空则按柜内顺序自动编号 */
  bale_labels?: string[]
  /** 柜号：这包货装在哪个柜/柜里 */
  box_no?: string
  /** 「同包再加一行」：这一行是往同一个包里再加一个规格 */
  same_package?: boolean
  /** 出库专用：这一行是从哪一包带出来的（服务端按包对账） */
  bale_id?: number | null
  /** 出库专用：这一行的包号（报错文案里用） */
  bale_no?: string
}

export type CreateInboundPayload = {
  supplier: string
  order_date: string
  remark?: string
  /** 仓库必填；操作员选填 */
  warehouse: string
  operator?: string
  /** 进口报关信息，选填 */
  bl_no?: string
  contract_no?: string
  /** 车号，选填 */
  vehicle_no?: string
  /** 整票到货时选提单，合同号/提单号从提单上继承 */
  shipment_id?: number
  items: InboundItemPayload[]
  /**
   * 这个提单号已经有一张活单时，后端回 409 让用户先确认；
   * 点「仍要新建」→ 用同一份 payload 加 `force:true` 重发，跳过这条校验。
   */
  force?: boolean
}

export type CreateInboundResult = {
  id: number
  order_no: string
}

export type InboundListItem = {
  id: number
  order_no: string
  supplier: string | null
  order_date: string | null
  warehouse: string | null
  operator: string | null
  bl_no: string | null
  contract_no: string | null
  vehicle_no: string | null
  /** 这张单里一共几个柜号（系统自动数） */
  box_count: number
  /** 这个合同号在合同库里有对应记录时给出 id，前端据此渲染成可点的链接 */
  contract_id: number | null
  /** 这张单下面的码单数与在库数 */
  bale_total: number
  bale_in_stock: number
  total_cubic: number
  total_amount: number
  item_count: number
}

export type InboundDetailItem = InboundItemPayload & {
  id: number
  order_id: number
  order_type: string
  /** 这行明细对应的包号（人填的原文，编辑时原样读回） */
  bale_no?: string | null
  cubic: number
  amount: number
  created_at: string
  /** 该规格当前库存（出库详情里用） */
  stock_cubic?: number
  stock_bundles?: number
}

export type InboundDetail = {
  id: number
  order_no: string
  supplier: string | null
  order_date: string | null
  remark: string | null
  warehouse: string | null
  operator: string | null
  bl_no: string | null
  contract_no: string | null
  vehicle_no: string | null
  contract_id: number | null
  created_at: string
  total_cubic: number
  total_amount: number
  items: InboundDetailItem[]
  /** 这张单下面的码单（每包状态：在库 / 已出库） */
  bales: Array<{
    /** 包的 id（打印标签要按 id 跳转） */
    id: number
    bale_no: string
    /** 条码号：就是要打印贴包上的那张码 */
    barcode: string
    box_no: string
    species: string
    grade: string
    thickness: number
    width: number
    length: number
    pieces: number
    /** 混装包：长度 / 片数的斜杠串（"1.8/2.1/2.4"、"17/30/247"） */
    length_text?: string
    pieces_text?: string
    cubic: number
    /**
     * 这一包里**属于本单**的立方。
     * 跨单合并出来的包只挂在主单下：`cubic` 是整包合计，`own_cubic` 是本单那部分，
     * 详情里按「本单 / 总」显示（相同时就是普通包，只显示一个数）。
     */
    own_cubic: number
    status: 'in_stock' | 'shipped'
    shipped_at: string | null
    outbound_order_no: string
  }>
}

export type InboundListFilters = {
  order_no?: string
  supplier?: string
  warehouse?: string
  operator?: string
  date_from?: string
  date_to?: string
  limit?: number
  offset?: number
}

/* ---------- 登录态 ---------- */

const TOKEN_KEY = 'wood-erp-token'
const USERNAME_KEY = 'wood-erp-username'

export function getToken() {
  return localStorage.getItem(TOKEN_KEY)
}

export function getStoredUsername() {
  return localStorage.getItem(USERNAME_KEY) ?? ''
}

export function setSession(token: string, username: string, role: Role) {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(USERNAME_KEY, username)
  setStoredRole(role)
}

export function setStoredUsername(username: string) {
  localStorage.setItem(USERNAME_KEY, username)
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USERNAME_KEY)
  clearStoredRole()
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const response = await fetch(url, { ...init, headers })
  const text = await response.text()

  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }

  if (!response.ok) {
    const message =
      (data as { error?: string } | null)?.error ?? `请求失败：${response.status}`

    if (response.status === 401) {
      clearSession()
      // 登录/校验登录态的接口由调用方决定跳转，这里避免重复跳转
      const isAuthApi = url.startsWith('/api/auth/')
      if (!isAuthApi && window.location.pathname !== '/login') {
        window.location.replace('/login')
      }
    }
    /**
     * 403 不清登录态：那是「登录着，但没这个权限」，
     * 把用户踢回登录页反而让他以为是密码错了。
     * 后端统一回「你没有这个操作的权限，请联系管理员」，这里原样抛给调用方弹提示。
     */

    /**
     * 把状态码和**原始返回体**一起挂在 error 上。
     *
     * 有些错误不是"一句话"就够的：比如入库保存撞上"这个提单号已经有活单"，
     * 后端回 409 + `{ code:'BL_HAS_ORDER', order:{ id, order_no, cubic } }`，
     * 前端要靠 `order.id` 跳「去编辑那张单」。以前这里把 body 拍平成一句 message，
     * 那些字段就丢了，跳不过去。
     */
    const error = new Error(message) as ApiError
    error.status = response.status
    error.payload = data as ApiError['payload']
    throw error
  }

  return data as T
}

/** 接口报错：除了 message，还带着 HTTP 状态码和后端原始返回体 */
export type ApiError = Error & {
  status?: number
  payload?: {
    error?: string
    code?: string
    /** `code: 'BL_HAS_ORDER'` 时带上那张已在用这个提单号的入库单 */
    order?: { id: number; order_no: string; cubic: number }
    /** `code: 'BALE_NO_TAKEN'` 时带上被占用的源包号（撤销改包要就地改号） */
    clashes?: BaleNoClash[]
  } | null
}

/** 「这个提单号已经有一张活单」的 409（入库保存时要弹三按钮确认） */
export function isBlHasOrderError(err: unknown): err is ApiError {
  return (
    err instanceof Error &&
    (err as ApiError).status === 409 &&
    (err as ApiError).payload?.code === 'BL_HAS_ORDER'
  )
}

/** 撤销改包时「源包号已经被别人占了 / 自己重号」的一条冲突 */
export type BaleNoClash = {
  /** 源包在改包前快照里的 id —— 回复新号时按它对应 */
  bale_id: number
  /** 这次要用的号（第一次就是原号） */
  bale_no: string
  /** 改包前的原包号 */
  original_bale_no: string
  reason?: 'taken' | 'duplicate'
}

/**
 * 撤销改包撞上「源包号被别人占了」的 409。
 * 前端要就地弹出输入框让用户改号，改完带着 `renames` 重发。
 */
export function isBaleNoTakenError(err: unknown): err is ApiError {
  return (
    err instanceof Error &&
    (err as ApiError).status === 409 &&
    (err as ApiError).payload?.code === 'BALE_NO_TAKEN'
  )
}

/* ---------- 认证接口 ---------- */

export type LoginResult = { token: string; username: string; role: Role }

export function login(username: string, password: string) {
  return request<LoginResult>('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
}

export function fetchMe() {
  return request<{ username: string; role: Role }>('/api/auth/me')
}

/** 改密码成功后所有旧 token 作废，调用方要重新登录 */
export function changePassword(oldPassword: string, newPassword: string) {
  return request<{ ok: boolean }>('/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldPassword, newPassword }),
  })
}

/* ---------- 用户管理（仅管理员） ---------- */

export type UserRow = {
  id: number
  username: string
  role: Role
  role_label: string
  active: boolean
  created_at: string
}

export type UserListResult = {
  roles: { value: Role; label: string }[]
  rows: UserRow[]
}

export function fetchUsers() {
  return request<UserListResult>('/api/users')
}

export function createUser(payload: { username: string; password: string; role: Role }) {
  return request<UserRow>('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

/** 改角色 / 停用启用。只传要改的字段即可 */
export function updateUser(id: number, payload: { role?: Role; active?: boolean }) {
  return request<UserRow>(`/api/users/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export function resetUserPassword(id: number, newPassword: string) {
  return request<{ ok: boolean; username: string }>(`/api/users/${id}/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newPassword }),
  })
}

// 忘记密码：用重置口令直接改密码（不需要登录）
export function resetPassword(payload: {
  username: string
  resetCode: string
  newPassword: string
}) {
  return request<{ ok: boolean; username: string }>('/api/auth/reset-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

/**
 * 需要登录态的下载：链接直连带不上 Authorization 头，
 * 所以这里用 fetch 取回文件再触发下载（文件名从响应头里取，保留中文）
 */
export async function downloadFile(url: string, fallbackName: string) {
  const token = getToken()
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })

  if (!response.ok) {
    if (response.status === 401) {
      clearSession()
      if (window.location.pathname !== '/login') window.location.replace('/login')
      throw new Error('未登录或登录已过期')
    }
    let message = `导出失败：${response.status}`
    try {
      const data = (await response.json()) as { error?: string }
      if (data?.error) message = data.error
    } catch {
      // 响应不是 JSON 就用默认提示
    }
    throw new Error(message)
  }

  const disposition = response.headers.get('Content-Disposition') ?? ''
  const matched = /filename\*=UTF-8''([^;]+)/i.exec(disposition)
  const fileName = matched ? decodeURIComponent(matched[1]) : fallbackName

  const blob = await response.blob()
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(objectUrl)
}

// 新增入库单
export function createInbound(payload: CreateInboundPayload) {
  return request<CreateInboundResult>('/api/inbound', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

// 入库单列表（筛选：单号/供应商/仓库/操作员/日期范围；支持分页）
export function fetchInboundList(filters: InboundListFilters = {}) {
  const query = new URLSearchParams()
  if (filters.order_no) query.set('order_no', filters.order_no)
  if (filters.supplier) query.set('supplier', filters.supplier)
  if (filters.warehouse) query.set('warehouse', filters.warehouse)
  if (filters.operator) query.set('operator', filters.operator)
  if (filters.date_from) query.set('date_from', filters.date_from)
  if (filters.date_to) query.set('date_to', filters.date_to)
  if (filters.limit) query.set('limit', String(filters.limit))
  if (filters.offset) query.set('offset', String(filters.offset))

  const search = query.toString()
  return request<Paged<InboundListItem>>(`/api/inbound${search ? `?${search}` : ''}`)
}

// 入库单详情
export function fetchInboundDetail(id: number) {
  return request<InboundDetail>(`/api/inbound/${id}`)
}

// 删除入库单（删完库存会变负时后端返回 400）
export function deleteInbound(id: number) {
  return request<{ ok: boolean }>(`/api/inbound/${id}`, { method: 'DELETE' })
}

// 修改入库单：明细整体替换，单号不变；库存会按差异自动调整
export function updateInbound(id: number, payload: CreateInboundPayload) {
  return request<CreateInboundResult>(`/api/inbound/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

/**
 * 按提单号查「这票货下面还有没有活着的入库单」（提单号输入框失焦时用）。
 * `excludeId`：编辑入库单时排除自己那张。
 */
export function fetchInboundByBlNo(params: { blNo: string; excludeId?: number }) {
  const query = new URLSearchParams({ bl_no: params.blNo })
  if (params.excludeId) query.set('exclude_id', String(params.excludeId))
  return request<{
    bl_no: string
    order: { id: number; order_no: string; order_date: string; supplier: string; cubic: number; item_count: number } | null
  }>(`/api/inbound/by-bl?${query.toString()}`)
}

/* ---------- 出库 ---------- */

export type CreateOutboundPayload = {
  customer: string
  order_date: string
  remark?: string
  /** 仓库必填；操作员选填 */
  warehouse: string
  operator?: string
  /** 车号，选填 */
  vehicle_no?: string
  /** 本次发走的码单 id（一包一个） */
  bale_ids: number[]
  items: InboundItemPayload[]
}

export type CreateOutboundResult = {
  id: number
  order_no: string
}

export type OutboundListItem = {
  id: number
  order_no: string
  customer: string | null
  order_date: string | null
  warehouse: string | null
  operator: string | null
  total_cubic: number
  total_amount: number
  item_count: number
}

export type OutboundDetail = {
  id: number
  order_no: string
  customer: string | null
  order_date: string | null
  remark: string | null
  warehouse: string | null
  operator: string | null
  vehicle_no: string | null
  created_at: string
  total_cubic: number
  total_amount: number
  items: InboundDetailItem[]
  /** 本次发走的码单 */
  bales: Array<{
    bale_no: string
    barcode: string
    cubic: number
    pieces: number
    /** 厚度 / 宽度（永远单值） */
    thickness: number
    width: number
    length: number
    /** 混装包：长度 / 片数的斜杠串（"1.8/2.1/2.4"、"17/30/247"） */
    length_text?: string
    pieces_text?: string
    status: string
    bl_no: string
    contract_no: string
  }>
}

export type OutboundListFilters = {
  order_no?: string
  customer?: string
  warehouse?: string
  operator?: string
  date_from?: string
  date_to?: string
  limit?: number
  offset?: number
}

export type StockSnapshot = {
  cubic: number
  bundles: number
  // 该规格最近一次入库的「每件片数」，出库表单用它自动带出片数
  pieces: number
}

export type StockQuery = {
  species: string
  grade: string
  thickness: number
  width: number
  length: number
}

// 新增出库单（库存不足时后端返回 400，错误信息会作为 Error 抛出）
export function createOutbound(payload: CreateOutboundPayload) {
  return request<CreateOutboundResult>('/api/outbound', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

// 出库单列表（可选筛选）
export function fetchOutboundList(filters: OutboundListFilters = {}) {
  const query = new URLSearchParams()
  if (filters.order_no) query.set('order_no', filters.order_no)
  if (filters.customer) query.set('customer', filters.customer)
  if (filters.warehouse) query.set('warehouse', filters.warehouse)
  if (filters.operator) query.set('operator', filters.operator)
  if (filters.date_from) query.set('date_from', filters.date_from)
  if (filters.date_to) query.set('date_to', filters.date_to)
  if (filters.limit) query.set('limit', String(filters.limit))
  if (filters.offset) query.set('offset', String(filters.offset))

  const search = query.toString()
  return request<Paged<OutboundListItem>>(`/api/outbound${search ? `?${search}` : ''}`)
}

// 出库单详情
export function fetchOutboundDetail(id: number) {
  return request<OutboundDetail>(`/api/outbound/${id}`)
}

/** 扫标签上的二维码（MZ|码单号|包号）→ 返回这一包的规格 / 立方 / 成本价 */
export type ScanBaleResult = {
  bale_id: number
  bale_no: string
  barcode: string
  box_no: string
  species: string
  grade: string
  thickness: number
  width: number
  length: number
  pieces: number
  bundles: number
  cubic: number
  /** 这一包的成本价（加权平均），取不到就是 null */
  unit_price: number | null
  /** 混装包：一包里有几段不同规格 */
  is_mixed: boolean
  /** 这一包的规格行 —— 出库明细按它逐行展开，别拿主规格拼一行 */
  /** 长度 / 片数斜杠串（混装包一行显示用） */
  length_text?: string
  pieces_text?: string
  items: Array<{
    brand: string
    species: string
    grade: string
    thickness: number
    width: number
    length: number
    pieces: number
    cubic: number
    unit_price: number
  }>
}

export function scanOutboundBale(code: string) {
  return request<ScanBaleResult>(
    `/api/outbound/scan?code=${encodeURIComponent(code)}`,
  )
}

// 删除出库单
export function deleteOutbound(id: number) {
  return request<{ ok: boolean }>(`/api/outbound/${id}`, { method: 'DELETE' })
}

// 修改出库单：明细整体替换，单号不变；库存不够时后端返回 400
export function updateOutbound(id: number, payload: CreateOutboundPayload) {
  return request<CreateOutboundResult>(`/api/outbound/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

// 某规格的当前库存（出库表单实时提示用）
export function fetchStock(spec: StockQuery) {
  const query = new URLSearchParams({
    species: spec.species,
    grade: spec.grade,
    thickness: String(spec.thickness),
    width: String(spec.width),
    length: String(spec.length),
  })
  return request<StockSnapshot>(`/api/outbound/stock?${query.toString()}`)
}

/* ---------- 库存 ---------- */

export type StockRow = {
  species: string
  grade: string
  thickness: number
  width: number
  length: number
  total_bundles: number
  total_pieces: number
  total_cubic: number
  /** 库存均价 = 该规格所有入库的 Σ(立方×单价) ÷ Σ立方 */
  avg_unit_price: number | null
}

// 库存列表（可选按品名模糊筛选），后端实时汇总
export function fetchStockList(species = '') {
  const query = new URLSearchParams()
  if (species) query.set('species', species)
  const search = query.toString()
  return request<StockRow[]>(`/api/stock${search ? `?${search}` : ''}`)
}

/* ---------- 对账 / 应收应付 ---------- */

export type SettlementSide = 'customer' | 'supplier'

export type SettlementSummaryRow = {
  partner: string
  order_amount: number
  order_count: number
  paid: number
  balance: number
  last_order_date: string | null
}

export type SettlementSummary = {
  side: SettlementSide
  rows: SettlementSummaryRow[]
  totals: { order_amount: number; paid: number; balance: number }
}

export type StatementRow = {
  date: string
  kind: 'order' | 'payment'
  no: string
  summary: string
  cubic: number
  amount: number
  balance: number
}

export type Statement = {
  side: SettlementSide
  partner: string
  date_from: string
  date_to: string
  opening: number
  rows: StatementRow[]
  period_occurred: number
  period_paid: number
  closing: number
}

export type PaymentRow = {
  id: number
  payment_no: string
  side: SettlementSide
  partner: string
  amount: number
  pay_date: string | null
  method: string
  remark: string
  created_at: string
}

export type StatementQuery = {
  side: SettlementSide
  partner: string
  date_from?: string
  date_to?: string
}

// 应收 / 应付总览：按往来单位列出累计发生、已收付和当前余额
export function fetchSettlementSummary(side: SettlementSide) {
  return request<SettlementSummary>(`/api/settlement/summary?side=${side}`)
}

// 对账单：期初 + 本期发生 - 本期收付 = 期末，逐行带滚动余额
export function fetchStatement(query: StatementQuery) {
  const search = new URLSearchParams({ side: query.side, partner: query.partner })
  if (query.date_from) search.set('date_from', query.date_from)
  if (query.date_to) search.set('date_to', query.date_to)
  return request<Statement>(`/api/settlement/statement?${search.toString()}`)
}

export type PaymentQuery = {
  side: SettlementSide
  payment_no?: string
  partner?: string
  method?: string
  date_from?: string
  date_to?: string
  limit?: number
  offset?: number
}

export type PaymentPage = Paged<PaymentRow> & { total_amount: number }

// 收付款记录（支持筛选与分页）
export function fetchPayments(query: PaymentQuery) {
  const search = new URLSearchParams({ side: query.side })
  if (query.payment_no) search.set('payment_no', query.payment_no)
  if (query.partner) search.set('partner', query.partner)
  if (query.method) search.set('method', query.method)
  if (query.date_from) search.set('date_from', query.date_from)
  if (query.date_to) search.set('date_to', query.date_to)
  if (query.limit) search.set('limit', String(query.limit))
  if (query.offset) search.set('offset', String(query.offset))
  return request<PaymentPage>(`/api/settlement/payments?${search.toString()}`)
}

export function createPayment(payload: {
  side: SettlementSide
  partner: string
  amount: number
  pay_date: string
  method?: string
  remark?: string
}) {
  return request<{ ok: boolean; payment_no: string }>('/api/settlement/payments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export function deletePayment(id: number) {
  return request<{ ok: boolean }>(`/api/settlement/payments/${id}`, {
    method: 'DELETE',
  })
}

// 对账单导出链接（后端生成 xlsx）
export function statementExportUrl(query: StatementQuery) {
  const search = new URLSearchParams({ side: query.side, partner: query.partner })
  if (query.date_from) search.set('date_from', query.date_from)
  if (query.date_to) search.set('date_to', query.date_to)
  return `/api/settlement/export?${search.toString()}`
}

/* ---------- 回收站 ---------- */

export type ShipmentRow = {
  id: number
  bl_no: string
  contract_no: string
  supplier: string
  arrival_date: string
  remark: string
  bale_total: number
  bale_in_stock: number
  bale_cubic: number
  /**
   * 这一票里**属于本提单**的立方（跨提单合并进来的货不算）。
   * 小于 `bale_cubic` 时界面上显示「本单 / 总」。
   */
  own_cubic: number
  /**
   * 这一票「原本入库」的立方 —— 入库明细（order_items）的合计。
   * 改包是按每行的来源单各挂各的单，所以这个数**改包前后不变**；出库也不动它。
   * `bale_cubic !== original_cubic` = 这一票被改包混过：
   *   大于 = 活包里混进了别的提单的货；小于 = 自己的货被并到别人的包里了。
   */
  original_cubic: number
  box_count: number
  created_at: string
}

/** 入库表单选的提单：带上已经贴了几张码单、下一个条码号从几开始 */
export type ShipmentOption = {
  id: number
  bl_no: string
  contract_no: string | null
  supplier: string | null
  arrival_date: string | null
  bale_count: number
  /** 这张提单里有几个柜（按柜号去重） */
  box_count: number
  next_seq: number
}

export function fetchShipmentOptions() {
  return request<ShipmentOption[]>('/api/shipments/options')
}

// 提单列表（一票到货 = 一张提单，下面直接是包）
export function fetchShipments(
  query: {
    keyword?: string
    /** 精确按合同号筛（采购入库明细三层用） */
    contract_no?: string
    /** 只要「没填合同号」的那几张提单（底部兜底提示用） */
    unlinked?: boolean
    supplier?: string
    limit?: number
    offset?: number
  } = {},
) {
  const search = new URLSearchParams()
  if (query.keyword) search.set('keyword', query.keyword)
  if (query.contract_no) search.set('contract_no', query.contract_no)
  if (query.unlinked) search.set('unlinked', '1')
  if (query.supplier) search.set('supplier', query.supplier)
  if (query.limit) search.set('limit', String(query.limit))
  if (query.offset) search.set('offset', String(query.offset))
  const qs = search.toString()
  return request<Paged<ShipmentRow>>(`/api/shipments${qs ? `?${qs}` : ''}`)
}

// 新建提单：一张提单直接开始贴包（柜这一层已经去掉了）
export function createShipment(payload: {
  bl_no: string
  contract_no?: string
  supplier?: string
  arrival_date?: string
  remark?: string
}) {
  return request<{ id: number; bl_no: string }>('/api/shipments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export function deleteShipment(id: number) {
  return request<{ ok: boolean }>(`/api/shipments/${id}`, { method: 'DELETE' })
}

export type BaleRow = {
  id: number
  bale_no: string
  /** 条码号：就是要打印贴包上的那张码 */
  barcode: string
  /** 柜号 */
  box_no: string
  shipment_id: number | null
  bl_no: string
  contract_no: string
  inbound_order_id: number | null
  outbound_order_id: number | null
  outbound_order_no: string
  species: string
  grade: string
  thickness: number
  width: number
  length: number
  pieces: number
  cubic: number
  /**
   * 整包里属于**这一包主单**的那部分立方。
   * 跨单合并出来的包只挂在主单下，`own_cubic` 会小于 `cubic`；
   * 普通包两个数相等。判"混单包"就看 `own_cubic < cubic`。
   */
  own_cubic: number
  /** 混装包：这一包里有几段不同规格 */
  is_mixed: boolean
  /** 长度斜杠串：混装包 "1.8/2.1/2.4"，单规格就是原来的数字 */
  length_text: string
  /** 片数斜杠串：混装包 "17/30/247" */
  pieces_text: string
  /** 给人看的一行规格说明：混装包 "33×22×1.8/2.1/2.4"，别拿它重算立方 */
  spec_text: string
  status: 'in_stock' | 'shipped'
  created_at: string
  shipped_at: string | null
}

export type BaleQuery = {

  keyword?: string
  status?: '' | 'in_stock' | 'shipped'
  shipment_id?: number
  /** 精确按合同号筛（这一包挂的提单属于这个合同） */
  contract_no?: string
  box_no?: string
  /** 改包选货用：按仓库 / 入库日期筛 */
  warehouse?: string
  date_from?: string
  date_to?: string
  species?: string
  limit?: number
  offset?: number
}

export type BaleItemLine = {
  id?: number
  /** 品牌（选填）：只记不参与匹配 */
  brand?: string
  species: string
  grade: string
  thickness: number
  width: number
  length: number
  pieces: number
  cubic: number
  /** 这一行自己的单价（原样带回，后端就不会用「最近入库价」重算） */
  unit_price?: number
}

export type BaleDetail = {
  id: number
  bale_no: string
  barcode: string
  box_no: string
  /** 提单号（打印标签要用） */
  bl_no: string
  shipment_id: number | null
  inbound_order_id: number | null
  status: 'in_stock' | 'shipped'
  cubic: number
  pieces: number
  items: BaleItemLine[]
}

// 码单详情（编辑弹窗用）
export function fetchBaleDetail(id: number) {
  return request<BaleDetail>(`/api/bales/${id}`)
}

// 编辑码单：包号 + 规格行（后端会把入库单明细一起同步）
export function updateBale(
  id: number,
  payload: {
    bale_no: string
    /** 柜号（可空） */
    box_no?: string
    items: Array<{
      species: string
      grade: string
      thickness: number
      width: number
      length: number
      pieces: number
      /** 原样带回的单价（0/不传 = 让后端按原行兜底） */
      unit_price?: number
    }>
  },
) {
  return request<{
    id: number
    bale_no: string
    amount_before: number
    amount_after: number
    amount_changed: boolean
  }>(`/api/bales/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

// 删除码单（只能删在库的，已出库要先撤销出库单）
export function deleteBale(id: number) {
  return request<{ ok: boolean; bale_no: string }>(`/api/bales/${id}`, {
    method: 'DELETE',
  })
}

// 包列表（一包一条，带条码号/柜号/提单号/合同号/出库单号）
export function fetchBales(query: BaleQuery = {}) {
  const search = new URLSearchParams()
  if (query.keyword) search.set('keyword', query.keyword)
  if (query.status) search.set('status', query.status)
  if (query.shipment_id) search.set('shipment_id', String(query.shipment_id))
  if (query.contract_no) search.set('contract_no', query.contract_no)
  if (query.box_no) search.set('box_no', query.box_no)
  if (query.warehouse) search.set('warehouse', query.warehouse)
  if (query.date_from) search.set('date_from', query.date_from)
  if (query.date_to) search.set('date_to', query.date_to)
  if (query.species) search.set('species', query.species)
  if (query.limit) search.set('limit', String(query.limit))
  if (query.offset) search.set('offset', String(query.offset))
  const qs = search.toString()
  return request<
    Paged<BaleRow> & {
      /** 当前筛选范围内的在库包数 / 在库立方（列表头那句「共 N 包（在库 M）· 合计 X m³」用的） */
      total_in_stock: number
      cubic_in_stock: number
    }
  >(`/api/bales${qs ? `?${qs}` : ''}`)
}

/** 包号查重：范围是「这张提单内」或「这张散货入库单内」 */
export function checkBaleNo(query: {
  bale_no: string
  shipment_id?: number
  inbound_order_id?: number
}) {
  const search = new URLSearchParams()
  search.set('bale_no', query.bale_no)
  if (query.shipment_id) search.set('shipment_id', String(query.shipment_id))
  if (query.inbound_order_id) {
    search.set('inbound_order_id', String(query.inbound_order_id))
  }
  return request<{ exists: boolean; barcode: string; scope: string }>(
    `/api/bales/check?${search.toString()}`,
  )
}

export type ContractRow = {
  id: number
  contract_no: string
  title: string
  partner: string
  sign_date: string
  amount: number
  remark: string
  file_original: string
  file_size: number
  has_file: boolean
  created_at: string
}

export type ContractOption = {
  id: number
  contract_no: string
  title: string
  partner: string
}

/** 选合同大页面的一行：带上这个合同已经入了多少 */
export type ContractPickerRow = {
  id: number
  contract_no: string
  title: string
  partner: string
  sign_date: string
  amount: number
  /** 合同明细的总数量（件） */
  total_qty: number
  species_text: string
  brand_text: string
  /** 已经入库的件数 */
  in_bundles: number
  in_orders: number
  in_cubic: number
  in_amount: number
  /** 未发货（件）= 总数量 − 已入库 */
  left_qty: number
  /** 未到货方数 = 合同总立方 − 已入库立方 */
  left_cubic: number
  /** 未发货 / 部分发货 / 全部发货 */
  status: string
  /** 这张合同已经开过的入库单，点一下能跳过去改 */
  orders: Array<{ id: number; order_no: string; order_date: string }>
}

export type ContractPickerQuery = {
  keyword?: string
  limit?: number
  offset?: number
}

// 采购入库「关联采购合同」用的大列表
export function fetchContractPicker(query: ContractPickerQuery = {}) {
  const search = new URLSearchParams()
  if (query.keyword) search.set('keyword', query.keyword)
  if (query.limit) search.set('limit', String(query.limit))
  if (query.offset) search.set('offset', String(query.offset))
  const qs = search.toString()
  return request<Paged<ContractPickerRow>>(
    `/api/contracts/picker${qs ? `?${qs}` : ''}`,
  )
}

export type ContractQuery = {
  keyword?: string
  partner?: string
  date_from?: string
  date_to?: string
  limit?: number
  offset?: number
}

/** 合同明细：只记「定了什么货」——品牌 / 品名 / 等级 / 数量 / 单价 / 金额 */
export type ContractItem = {
  id: number
  brand: string
  species: string
  grade: string
  quantity: number
  unit_price: number
  amount: number
  remark: string
}

export type ContractDetail = ContractRow & { items: ContractItem[] }

export function fetchContractDetail(id: number) {
  return request<ContractDetail>(`/api/contracts/${id}`)
}

// 合同列表（合同号/名称关键字、往来单位、签订日期范围，支持分页）
export function fetchContracts(query: ContractQuery = {}) {
  const search = new URLSearchParams()
  if (query.keyword) search.set('keyword', query.keyword)
  if (query.partner) search.set('partner', query.partner)
  if (query.date_from) search.set('date_from', query.date_from)
  if (query.date_to) search.set('date_to', query.date_to)
  if (query.limit) search.set('limit', String(query.limit))
  if (query.offset) search.set('offset', String(query.offset))
  const qs = search.toString()
  return request<Paged<ContractRow>>(`/api/contracts${qs ? `?${qs}` : ''}`)
}

// 入库单填合同号时的候选列表
export function fetchContractOptions() {
  return request<ContractOption[]>('/api/contracts/options')
}

/* ---------- 常用项字典（品名 / 等级） ---------- */

export type DictKind = 'species' | 'grade'

export type DictItem = {
  id: number
  kind: DictKind
  name: string
}

export type DictAll = {
  species: DictItem[]
  grade: DictItem[]
}

/** 常用品名 / 等级，录单时当候选 */
export function fetchDict() {
  return request<DictAll>('/api/dict')
}

export function addDictItem(kind: DictKind, name: string) {
  return request<{ ok: boolean; id: number; kind: DictKind; name: string }>(
    '/api/dict',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, name }),
    },
  )
}

export function renameDictItem(id: number, name: string) {
  return request<{ ok: boolean }>(`/api/dict/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

export function deleteDictItem(id: number) {
  return request<{ ok: boolean }>(`/api/dict/${id}`, { method: 'DELETE' })
}

/* ---------- 改包 ---------- */

export type RepackLine = {
  /** 规格行 id（包里的行才有；改包前选成本价要按它回传） */
  id?: number
  /** 这一行来自哪张入库单（合并改包时一包里会混好几张单的货） */
  src_inbound_order_id?: number | null
  /** 这一行来自哪个源包（改包前的行会带；「查看」弹窗按它归类） */
  src_bale_id?: number | null
  src_bale_no?: string
  brand?: string
  species: string
  grade: string
  thickness: number
  width: number
  length: number
  pieces: number
  /** 混装行的原文（"1.8/2.1/2.4"、"17/30/247"）；普通行就是单个值 */
  length_text?: string
  pieces_text?: string
  cubic: number
  /** 入库时的单价（改前成本算它） */
  unit_price?: number
  /** 同一规格在入库明细里匹配到多个价 → 要让用户选，不能静默取第一条 */
  price_ambiguous?: boolean
  price_candidates?: Array<{
    order_item_id: number
    brand: string
    unit_price: number
    count: number
  }>
}

export type RepackRow = {
  id: number
  repack_no: string
  repack_date: string
  /** 'spec' 改规格 / 'split' 拆包 */
  kind: 'spec' | 'split'
  /** 改包后的包数（改规格固定 1，拆包是拆出来的个数） */
  bale_count: number
  bale_id: number | null
  barcode: string
  bale_no: string
  summary: string
  remark: string
  before_cubic: number
  before_amount: number
  after_cubic: number
  after_amount: number
  loss_cubic: number
  /** 损耗率 %（改前方数为 0 时为 null） */
  loss_rate: number | null
  /** 制单人 */
  created_by: string
  loss_amount: number
  price_pinned: boolean
  before_items: RepackLine[]
  after_items: RepackLine[]
  /** 拆包时才有：改后每个包的包号 / 条码号 / 规格行 */
  after_bales: Array<{
    bale_no: string
    barcode: string
    items: RepackLine[]
  }> | null
  /** 这条记录改了几个源包（多选改包 ≥ 2）*/
  source_bale_count: number
  /** 源包号（空的跳过），列表 / 查看里显示「A2、A5」 */
  source_bale_nos: string[]
  bl_no: string
  contract_no: string
  created_at: string
}

export type RepackSums = {
  before_cubic: number
  after_cubic: number
  loss_cubic: number
  loss_rate: number | null
  before_amount: number
  after_amount: number
}

export type RepackPage = Paged<RepackRow> & { sums: RepackSums }

export type RepackQuery = {
  date_from?: string
  date_to?: string
  species?: string
  keyword?: string
  limit?: number
  offset?: number
}

/** 可以改包的包（在库的，带规格行） */
export type RepackBale = {
  id: number
  bale_no: string
  barcode: string
  cubic: number
  pieces: number
  contract_no: string
  bl_no: string
  items: RepackLine[]
}

export function fetchRepackBales() {
  return request<RepackBale[]>('/api/repacks/bales')
}

export function fetchRepackList(query: RepackQuery = {}) {
  const search = new URLSearchParams()
  if (query.date_from) search.set('date_from', query.date_from)
  if (query.date_to) search.set('date_to', query.date_to)
  if (query.species) search.set('species', query.species)
  if (query.keyword) search.set('keyword', query.keyword)
  if (query.limit) search.set('limit', String(query.limit))
  if (query.offset) search.set('offset', String(query.offset))
  const qs = search.toString()
  return request<RepackPage>(`/api/repacks${qs ? `?${qs}` : ''}`)
}

export function createRepack(payload: {
  repack_date: string
  /** 源包（多选改包）：1 个就是改这一包，多个就是合并 / 重排 */
  bale_ids: number[]
  summary?: string
  remark?: string
  /**
   * 「改包后总量比改包前少」确认后为 true。
   * 不带 = 后端不许丢货（少 > 0.0001 直接 400）。
   */
  force?: boolean
  bl_no?: string
  contract_no?: string
  /** 改包前每一行选定的成本价：{ [规格行 id]: 单价 }（只有匹配到多个价时才用） */
  before_prices?: Record<string, number>
  /**
   * 改包后的分组：一组 = 一个包。
   * 只有一组 = 改这一包的规格；多组 = 把这一包拆成几个。
   * 包号留空就是真的空（不拿条码号顶替）。
   */
  groups: Array<{
    bale_no?: string
    items: Array<{
      brand?: string
      species: string
      grade: string
      thickness: number
      width: number
      /** 混装行可以是斜杠串（"1.8/2.1/2.4"），后端按段展开 */
      length: number | string
      pieces: number | string
      unit_price?: number
      /**
       * 这一行是从哪个源包来的（「复制改包前数据」「一键拆包」会自动带上）。
       * 后端据此把这一行的账落回原来那张入库单；不带就按规格匹配。
       */
      srcBaleId?: number
    }>
  }>
}) {
  return request<{
    id: number
    repack_no: string
    kind: 'spec' | 'split'
    bale_count: number
  }>('/api/repacks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

/**
 * 撤销一条改包记录。
 *
 * `renames`（可选）：`{ [源包 id]: '新包号' }` —— 只在后端回了
 * `BALE_NO_TAKEN`（源包号被别人占了）之后用：让用户当场改号，再带上来重发。
 */
export function deleteRepack(id: number, renames?: Record<number, string>) {
  const hasRenames = renames && Object.keys(renames).length > 0
  return request<{
    ok: boolean
    repack_no: string
    /** 撤销后回来的源包（新 id）——「编辑」用它把源包重新选回来 */
    restored_bales?: Array<{ id: number; bale_no: string; barcode: string }>
    restored_bale?: string
  }>(`/api/repacks/${id}`, {
    method: 'DELETE',
    ...(hasRenames
      ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ renames }),
        }
      : {}),
  })
}

// 新增 / 修改合同（multipart，含 PDF 文件）
export function saveContract(form: FormData, id?: number) {
  return request<{ ok: boolean; contract_no: string }>(
    id ? `/api/contracts/${id}` : '/api/contracts',
    { method: id ? 'PUT' : 'POST', body: form },
  )
}

export function deleteContract(id: number) {
  return request<{ ok: boolean }>(`/api/contracts/${id}`, { method: 'DELETE' })
}

/**
 * 打开合同 PDF。
 *
 * 接口需要 Authorization 头，而新标签页直接打开 URL 带不上头，
 * 所以先把 PDF 取成 blob 再打开——这样 token 不用暴露在地址栏里。
 */
export async function openContractFile(id: number) {
  // 先同步开一个空白标签页：等 fetch 回来再 window.open 会被浏览器当弹窗拦掉
  const tab = window.open('', '_blank')

  try {
    const token = getToken()
    const response = await fetch(`/api/contracts/${id}/file`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })

    if (!response.ok) {
      let message = '打开合同失败'
      try {
        const data = await response.json()
        if (data?.error) message = data.error
      } catch {
        // 忽略解析失败，用默认文案
      }
      throw new Error(message)
    }

    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    if (tab) {
      tab.location.href = url
    } else {
      // 连空白标签都没开出来（被严格拦截）就直接在当前页打开
      window.location.href = url
    }
    // 新窗口加载完再释放，太早释放会导致白屏
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  } catch (err) {
    tab?.close()
    throw err
  }
}

export function formatFileSize(bytes: number) {
  if (!bytes) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export type RecycleRow = {
  type: 'in' | 'out' | 'contract'
  id: number
  order_no: string
  partner: string | null
  order_date: string | null
  deleted_at: string
  total_cubic: number
  total_amount: number
  /** 入库/出库单 = 明细行数；合同 = 这张合同下的入库单张数 */
  item_count: number
}

// 回收站列表：被软删除的合同 / 入库 / 出库单
export function fetchRecycleList() {
  return request<RecycleRow[]>('/api/recycle')
}

// 恢复单据（恢复出库单时库存不够会返回 400，错误信息原样展示）
export function restoreRecycleOrder(type: RecycleRow['type'], id: number) {
  return request<{ ok: boolean }>('/api/recycle/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, id }),
  })
}

// 彻底删除（连明细一起物理删掉，删完不可恢复）
export function purgeRecycleOrder(type: RecycleRow['type'], id: number) {
  return request<{ ok: boolean }>(`/api/recycle/${type}/${id}`, {
    method: 'DELETE',
  })
}

/* ---------- 盘点 ---------- */

export type CountListRow = {
  id: number
  count_no: string
  count_date: string | null
  remark: string | null
  item_count: number
  diff_cubic: number
  in_order_no: string | null
  out_order_no: string | null
  created_at: string
}

export type CountDetailItem = {
  id: number
  count_id: number
  species: string | null
  grade: string | null
  thickness: number
  width: number
  length: number
  pieces: number
  book_bundles: number
  book_cubic: number
  actual_bundles: number
  diff_bundles: number
  diff_cubic: number
  unit_price: number
  created_at: string
}

export type CountDetail = CountListRow & { items: CountDetailItem[] }

export type CountLinePayload = {
  species: string
  grade: string
  thickness: number
  width: number
  length: number
  pieces: number
  actual_bundles: number
  unit_price: number
}

export type CreateCountPayload = {
  count_date: string
  remark?: string
  items: CountLinePayload[]
}

export type CreateCountResult = {
  id: number
  count_no: string
  item_count: number
  diff_cubic: number
  in_order_no: string | null
  out_order_no: string | null
}

// 盘点单列表
export function fetchCountList() {
  return request<CountListRow[]>('/api/count')
}

// 盘点单详情（含账面 / 实盘 / 差异明细）
export function fetchCountDetail(id: number) {
  return request<CountDetail>(`/api/count/${id}`)
}

// 新增盘点单：盘盈生成入库单、盘亏生成出库单，由服务端算差异
export function createCount(payload: CreateCountPayload) {
  return request<CreateCountResult>('/api/count', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

// 撤销盘点单（连带删掉它生成的盘盈 / 盘亏单）
export function deleteCount(id: number) {
  return request<{ ok: true }>(`/api/count/${id}`, { method: 'DELETE' })
}

/* ---------- 首页 ---------- */

export type HomeRecord = {
  type: 'in' | 'out'
  order_no: string
  partner: string | null
  order_date: string | null
  total_cubic: number
  total_amount: number
  item_count: number
  created_at: string
}

export type HomeTrendDay = {
  date: string
  in_cubic: number
  out_cubic: number
}

export type HomeComposition = {
  label: string
  cubic: number
  share: number
}

export type HomeCompare = {
  cubic: number
  amount: number
  prev_cubic: number
  prev_amount: number
  yoy_cubic: number
  yoy_amount: number
  /** 基数为 0 时是 null，前端显示「—」 */
  mom_percent: number | null
  yoy_percent: number | null
  mom_amount_percent: number | null
  yoy_amount_percent: number | null
}

export type HomeArrival = {
  order_no: string
  order_date: string | null
  supplier: string | null
  cubic: number
  amount: number
  days_ago: number | null
}

export type HomeSummary = {
  total_stock_cubic: number
  total_stock_bundles: number
  total_stock_amount: number
  stock_delta_cubic: number
  stock_delta_percent: number
  receivable_total: number
  payable_total: number
  trend: HomeTrendDay[]
  composition: HomeComposition[]
  composition_dimension: HomeCompositionDimension
  compare: {
    days: number
    dimension: HomeCompositionDimension
    period: { from: string; to: string }
    prev: { from: string; to: string }
    yoy: { from: string; to: string }
    in: HomeCompare
    out: HomeCompare
  }
  daily_out_cubic: number
  outbound_30d_cubic: number
  sold_days: number
  days_of_supply: number | null
  recent_arrival: HomeArrival | null
  arrival_batches_365: number
  today_in_cubic: number
  today_in_amount: number
  today_out_cubic: number
  today_out_amount: number
  recent_records: HomeRecord[]
}

export type HomeCompositionDimension = 'spec' | 'species' | 'grade'

export type HomeSummaryQuery = {
  /** 走势周期：7 / 14 / 30 天 */
  days?: 7 | 14 | 30
  /** 库存构成维度：规格 / 品名 / 等级 */
  dimension?: HomeCompositionDimension
}

// 首页汇总（库存、出货速度、应收应付、走势、构成、最近流水）
export function fetchHomeSummary(query: HomeSummaryQuery = {}) {
  const search = new URLSearchParams()
  if (query.days) search.set('days', String(query.days))
  if (query.dimension) search.set('dimension', query.dimension)
  const qs = search.toString()
  return request<HomeSummary>(`/api/home/summary${qs ? `?${qs}` : ''}`)
}

/* ---------- 流水 ---------- */

export type RecordRow = {
  record_id: number
  order_no: string
  order_type: 'in' | 'out'
  order_date: string | null
  created_at: string
  partner: string | null
  species: string
  grade: string
  thickness: number
  width: number
  length: number
  pieces: number
  bundles: number
  cubic: number
  unit_price: number
  amount: number
}

export type RecordQuery = {
  type?: '' | 'in' | 'out'
  date_from?: string
  date_to?: string
  species?: string
  partner?: string
  limit?: number
  offset?: number
}

export type RecordResult = {
  total: number
  limit: number
  offset: number
  records: RecordRow[]
}

// 出入库流水（明细行级别，支持筛选与分页）
export function fetchRecords(query: RecordQuery = {}) {
  const search = new URLSearchParams()
  if (query.type) search.set('type', query.type)
  if (query.date_from) search.set('date_from', query.date_from)
  if (query.date_to) search.set('date_to', query.date_to)
  if (query.species) search.set('species', query.species)
  if (query.partner) search.set('partner', query.partner)
  if (query.limit !== undefined) search.set('limit', String(query.limit))
  if (query.offset !== undefined) search.set('offset', String(query.offset))

  const qs = search.toString()
  return request<RecordResult>(`/api/records${qs ? `?${qs}` : ''}`)
}

/* ---------- 导出（后端生成 xlsx，前端只负责发下载请求） ---------- */

export type InboundExportFilters = {
  supplier?: string
  date_from?: string
  date_to?: string
}

export type OutboundExportFilters = {
  customer?: string
  date_from?: string
  date_to?: string
}

export function inboundExportUrl(filters: InboundExportFilters = {}) {
  const query = new URLSearchParams()
  if (filters.supplier) query.set('supplier', filters.supplier)
  if (filters.date_from) query.set('date_from', filters.date_from)
  if (filters.date_to) query.set('date_to', filters.date_to)
  const search = query.toString()
  return `/api/export/inbound${search ? `?${search}` : ''}`
}

export function outboundExportUrl(filters: OutboundExportFilters = {}) {
  const query = new URLSearchParams()
  if (filters.customer) query.set('customer', filters.customer)
  if (filters.date_from) query.set('date_from', filters.date_from)
  if (filters.date_to) query.set('date_to', filters.date_to)
  const search = query.toString()
  return `/api/export/outbound${search ? `?${search}` : ''}`
}

export function stockExportUrl(species = '') {
  const query = new URLSearchParams()
  if (species) query.set('species', species)
  const search = query.toString()
  return `/api/export/stock${search ? `?${search}` : ''}`
}

/* ---------- AI 助手（DeepSeek） ---------- */

export type AiMessage = { role: 'user' | 'assistant'; content: string }

/**
 * 问一句 AI。这一版是**一问一答**：把最近的对话整段发过去，拿一条回复回来
 * （没有流式输出，也就没有逐字打印的效果）。
 */
export function askAi(messages: AiMessage[]) {
  return request<{ reply: string; model: string; tools?: string[] }>('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  })
}
