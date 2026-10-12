export type InboundItemPayload = {
  species: string
  grade: string
  thickness: number
  width: number
  length: number
  pieces: number
  bundles: number
  unit_price: number
}

export type CreateInboundPayload = {
  supplier: string
  order_date: string
  remark?: string
  items: InboundItemPayload[]
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
  total_cubic: number
  total_amount: number
  item_count: number
}

export type InboundDetailItem = InboundItemPayload & {
  id: number
  order_id: number
  order_type: string
  cubic: number
  amount: number
  created_at: string
}

export type InboundDetail = {
  id: number
  order_no: string
  supplier: string | null
  order_date: string | null
  remark: string | null
  created_at: string
  total_cubic: number
  total_amount: number
  items: InboundDetailItem[]
}

export type InboundListFilters = {
  supplier?: string
  date_from?: string
  date_to?: string
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

export function setSession(token: string, username: string) {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(USERNAME_KEY, username)
}

export function setStoredUsername(username: string) {
  localStorage.setItem(USERNAME_KEY, username)
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USERNAME_KEY)
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

    throw new Error(message)
  }

  return data as T
}

/* ---------- 认证接口 ---------- */

export type LoginResult = { token: string; username: string }

export function login(username: string, password: string) {
  return request<LoginResult>('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
}

export function fetchMe() {
  return request<{ username: string }>('/api/auth/me')
}

export function changePassword(oldPassword: string, newPassword: string) {
  return request<{ ok: boolean }>('/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldPassword, newPassword }),
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

// 入库单列表（可选筛选）
export function fetchInboundList(filters: InboundListFilters = {}) {
  const query = new URLSearchParams()
  if (filters.supplier) query.set('supplier', filters.supplier)
  if (filters.date_from) query.set('date_from', filters.date_from)
  if (filters.date_to) query.set('date_to', filters.date_to)

  const search = query.toString()
  return request<InboundListItem[]>(`/api/inbound${search ? `?${search}` : ''}`)
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

/* ---------- 出库 ---------- */

export type CreateOutboundPayload = {
  customer: string
  order_date: string
  remark?: string
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
  created_at: string
  total_cubic: number
  total_amount: number
  items: InboundDetailItem[]
}

export type OutboundListFilters = {
  customer?: string
  date_from?: string
  date_to?: string
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
  if (filters.customer) query.set('customer', filters.customer)
  if (filters.date_from) query.set('date_from', filters.date_from)
  if (filters.date_to) query.set('date_to', filters.date_to)

  const search = query.toString()
  return request<OutboundListItem[]>(`/api/outbound${search ? `?${search}` : ''}`)
}

// 出库单详情
export function fetchOutboundDetail(id: number) {
  return request<OutboundDetail>(`/api/outbound/${id}`)
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
  last_unit_price: number | null
}

// 库存列表（可选按品名模糊筛选），后端实时汇总
export function fetchStockList(species = '') {
  const query = new URLSearchParams()
  if (species) query.set('species', species)
  const search = query.toString()
  return request<StockRow[]>(`/api/stock${search ? `?${search}` : ''}`)
}

/* ---------- 回收站 ---------- */

export type RecycleRow = {
  type: 'in' | 'out'
  id: number
  order_no: string
  partner: string | null
  order_date: string | null
  deleted_at: string
  total_cubic: number
  total_amount: number
  item_count: number
}

// 回收站列表：被软删除的入库 / 出库单
export function fetchRecycleList() {
  return request<RecycleRow[]>('/api/recycle')
}

// 恢复单据（恢复出库单时库存不够会返回 400，错误信息原样展示）
export function restoreRecycleOrder(type: 'in' | 'out', id: number) {
  return request<{ ok: boolean }>('/api/recycle/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, id }),
  })
}

// 彻底删除（连明细一起物理删掉，删完不可恢复）
export function purgeRecycleOrder(type: 'in' | 'out', id: number) {
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

export type HomeSummary = {
  total_stock_cubic: number
  total_stock_bundles: number
  total_stock_amount: number
  today_in_cubic: number
  today_in_amount: number
  today_out_cubic: number
  today_out_amount: number
  recent_records: HomeRecord[]
}

// 首页汇总（库存总量、今日出入库、最近 10 条流水）
export function fetchHomeSummary() {
  return request<HomeSummary>('/api/home/summary')
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
