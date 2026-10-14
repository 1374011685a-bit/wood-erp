/**
 * 权限与金额泄露的断言测试。
 *
 * 干的事：拿「看不到金额」的角色（sales / warehouse / viewer）的 token，
 * 把系统里**所有 GET 接口**跑一遍，扫响应体里有没有金额字段。
 * 有任何一个漏出来就报错、退出码非 0。
 *
 * 为什么要有这条测试：
 *   金额过滤是拦在 res.json 上的「全局行为」（见 middleware/permissions.js）。
 *   它靠一份字段黑名单工作，而黑名单是可能漏的 —— 比如以后有人加了个新接口
 *   返回 `ship_fee`，黑名单里没有，业务员就看到了。这条测试专门盯这件事。
 *
 * 用法：
 *   node server/tests/permission-audit.mjs
 *   BASE=http://localhost:3001 ADMIN_PASSWORD=xxx node server/tests/permission-audit.mjs
 *
 * 前置条件：数据库里要有一个管理员（默认 admin/admin123），
 * 以及三个探针账号（默认 t_sales / t_wh / t_view，密码 test123456）。
 * 探针账号不存在会跳过并在报告里写「不可用」，不算失败。
 * 用管理员在「用户管理」页建这三个号即可。
 */
import { isMoneyKey } from '../middleware/permissions.js'
import { seesMoney, ROLES } from '../permissions.js'

const BASE = process.env.BASE || 'http://localhost:3001'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'

/** 探针账号：角色 → 用户名:密码 */
const PROBES = [
  ['sales', process.env.AUDIT_SALES || 't_sales:test123456'],
  ['warehouse', process.env.AUDIT_WAREHOUSE || 't_wh:test123456'],
  ['viewer', process.env.AUDIT_VIEWER || 't_view:test123456'],
].map(([role, spec]) => {
  const [username, password] = String(spec).split(':')
  return { role, username, password }
})

/* ---------- HTTP 小工具 ---------- */

async function call(method, path, { token, raw = false } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  if (raw) return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()) }
  const text = await res.text()
  return { status: res.status, text }
}

async function login(username, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const body = await res.json().catch(() => null)
  if (!body?.token) {
    throw new Error(`${username} 登录失败（${res.status}）：${body?.error ?? ''}`)
  }
  return body.token
}

/* ---------- 递归扫描响应体 ---------- */

/** 找出 JSON 树里所有金额字段（连路径一起返回，方便定位是哪一层漏的） */
function findMoneyPaths(value, path = '$', hits = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findMoneyPaths(item, `${path}[${index}]`, hits))
    return hits
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (isMoneyKey(key)) hits.push(`${path}.${key}`)
      else findMoneyPaths(child, `${path}.${key}`, hits)
    }
  }
  return hits
}

/* ---------- 要扫的接口清单 ---------- */

/**
 * 固定清单 + 用真实 id 拼出来的详情页。
 * ctx 里是前面用管理员身份探测到的样本数据 id，这样有数据的库能扫得更全。
 */
function endpoints(ctx) {
  const list = [
    ['GET', '/api/ping'],
    ['GET', '/api/auth/me'],
    ['GET', '/api/home/summary'],
    ['GET', '/api/inbound?limit=5'],
    ['GET', '/api/outbound?limit=5'],
    ['GET', '/api/stock'],
    ['GET', '/api/records?limit=5'],
    ['GET', '/api/dict'],
    ['GET', '/api/bales?limit=5'],
    ['GET', '/api/contracts?limit=5'],
    ['GET', '/api/contracts/options'],
    ['GET', '/api/contracts/picker?limit=5'],
    ['GET', '/api/shipments'],
    ['GET', '/api/shipments/options'],
    ['GET', '/api/repacks?limit=5'],
    ['GET', '/api/repacks/bales'],
    ['GET', '/api/count'],
    ['GET', '/api/recycle'],
    // 规格参数写死成一个大概率存在的组合；参数不全只会拿到 400，不影响扫描
    [
      'GET',
      '/api/outbound/stock?species=%E6%A8%9F%E5%AD%90%E6%9D%BE&grade=SLDK&thickness=23&width=22&length=2',
    ],
    // 对账与用户管理只对部分角色开放，其余角色会 403 —— 403 也是「没泄露」，照样扫
    ['GET', '/api/settlement/summary?side=customer'],
    ['GET', '/api/settlement/summary?side=supplier'],
    ['GET', '/api/settlement/payments?side=customer&limit=5'],
    ['GET', '/api/settlement/payments?side=supplier&limit=5'],
    ['GET', '/api/users'],
  ]

  if (ctx.inboundId) list.push(['GET', `/api/inbound/${ctx.inboundId}`])
  if (ctx.outboundId) list.push(['GET', `/api/outbound/${ctx.outboundId}`])
  if (ctx.baleId) list.push(['GET', `/api/bales/${ctx.baleId}`])
  if (ctx.contractId) list.push(['GET', `/api/contracts/${ctx.contractId}`])
  if (ctx.shipmentId) list.push(['GET', `/api/shipments/${ctx.shipmentId}/containers`])
  if (ctx.countId) list.push(['GET', `/api/count/${ctx.countId}`])
  if (ctx.barcode) {
    list.push(['GET', `/api/outbound/scan?code=${encodeURIComponent(`MZ|${ctx.barcode}|${ctx.baleNo}`)}`])
  }
  if (ctx.baleNo) {
    list.push(['GET', `/api/bales/check?bale_no=${encodeURIComponent(ctx.baleNo)}`])
  }
  if (ctx.partner) {
    const partner = encodeURIComponent(ctx.partner)
    list.push(['GET', `/api/settlement/statement?side=customer&partner=${partner}`])
    list.push(['GET', `/api/settlement/statement?side=supplier&partner=${partner}`])
  }

  return list
}

/** Excel 导出：不走 res.json，要单独扒 xlsx 表头 */
const EXPORTS = [
  ['/api/export/inbound', ['单价', '金额']],
  ['/api/export/outbound', ['单价', '金额']],
  ['/api/export/stock', ['库存均价', '库存金额']],
  ['/api/settlement/export?side=customer&partner=__none__', ['金额', '发生', '余额']],
]

/* ---------- 主流程 ---------- */

const failures = []
const notes = []

async function collectContext(adminToken) {
  const ctx = {}
  const pick = async (path, picker) => {
    try {
      const res = await call('GET', path, { token: adminToken })
      return picker(JSON.parse(res.text))
    } catch {
      return undefined
    }
  }

  const asRows = (body) => (Array.isArray(body) ? body : (body?.rows ?? []))

  ctx.inboundId = await pick('/api/inbound?limit=1', (b) => asRows(b)[0]?.id)
  ctx.outboundId = await pick('/api/outbound?limit=1', (b) => asRows(b)[0]?.id)
  ctx.contractId = await pick('/api/contracts?limit=1', (b) => asRows(b)[0]?.id)
  ctx.partner = await pick('/api/contracts?limit=1', (b) => asRows(b)[0]?.partner)
  ctx.countId = await pick('/api/count', (b) => asRows(b)[0]?.id)
  ctx.shipmentId = await pick('/api/shipments', (b) => asRows(b)[0]?.id)

  const bale = await pick('/api/bales?limit=1', (b) => asRows(b)[0])
  ctx.baleId = bale?.id
  ctx.baleNo = bale?.bale_no
  ctx.barcode = bale?.barcode
  return ctx
}

async function auditRole(role, token, ctx) {
  const list = endpoints(ctx)
  let scanned = 0

  for (const [method, path] of list) {
    let res
    try {
      res = await call(method, path, { token })
    } catch (err) {
      failures.push(`${role} ${method} ${path} → 请求失败：${err.message}`)
      continue
    }
    scanned += 1

    let body
    try {
      body = JSON.parse(res.text)
    } catch {
      continue // 非 JSON（比如 401 的兜底页）本来就不含金额
    }

    const hits = [...new Set(findMoneyPaths(body))]
    if (hits.length > 0) {
      failures.push(
        `${role} ${method} ${path} → 泄露金额字段：${hits.slice(0, 5).join('、')}`,
      )
    }
  }

  // 导出：xlsx 是二进制，单独用 exceljs 读表头
  let exportChecked = 0
  for (const [path, headers] of EXPORTS) {
    let res
    try {
      res = await call('GET', path, { token, raw: true })
    } catch (err) {
      failures.push(`${role} GET ${path} → 请求失败：${err.message}`)
      continue
    }
    // 403/404 之类的错误回包是 JSON；只认 xlsx（zip 头 'PK'）
    if (res.status !== 200) continue
    if (res.buffer[0] !== 0x50 || res.buffer[1] !== 0x4b) continue

    const ExcelJS = (await import('exceljs')).default
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(res.buffer)
    const titles = (workbook.worksheets[0]?.getRow(3)?.values ?? []).map((v) =>
      String(v ?? ''),
    )
    exportChecked += 1
    const leaked = headers.filter((header) => titles.includes(header))
    if (leaked.length > 0) {
      failures.push(`${role} GET ${path} → 导出的 Excel 里还有金额列：${leaked.join('、')}`)
    }
  }

  return { scanned, exportChecked }
}

async function main() {
  console.log(`[权限审计] 目标：${BASE}`)

  let adminToken
  try {
    adminToken = await login(ADMIN_USER, ADMIN_PASSWORD)
  } catch (err) {
    console.error(`✗ ${err.message}`)
    process.exit(2)
  }

  const ctx = await collectContext(adminToken)
  console.log(
    `[权限审计] 样本数据：入库单=${ctx.inboundId ?? '无'} 出库单=${ctx.outboundId ?? '无'} ` +
      `码单=${ctx.baleId ?? '无'} 合同=${ctx.contractId ?? '无'} 提单=${ctx.shipmentId ?? '无'} ` +
      `盘点=${ctx.countId ?? '无'}`,
  )

  // 管理员必须**看得到**金额，否则说明过滤写反了
  const adminRes = await call('GET', '/api/inbound?limit=1', { token: adminToken })
  if (!/"total_amount":/.test(adminRes.text)) {
    failures.push('admin GET /api/inbound → 管理员应当看得到 total_amount，但响应里没有')
  }

  for (const role of ROLES) {
    if (seesMoney(role)) {
      notes.push(`${role}：按设计本来就能看金额，跳过金额扫描`)
      continue
    }

    const probe = PROBES.find((item) => item.role === role)
    if (!probe) continue

    let token
    try {
      token = await login(probe.username, probe.password)
    } catch (err) {
      notes.push(`${role}：探针账号 ${probe.username} 不可用（${err.message}），已跳过`)
      continue
    }

    const { scanned, exportChecked } = await auditRole(role, token, ctx)
    console.log(
      `[权限审计] ${role.padEnd(9)} 接口 ${scanned} 个 + 导出 ${exportChecked} 个`,
    )
  }

  console.log('')
  for (const note of notes) console.log(`  · ${note}`)
  console.log('')

  if (failures.length > 0) {
    console.error(`✗ 发现 ${failures.length} 处问题：`)
    for (const line of failures) console.error(`    ${line}`)
    process.exit(1)
  }

  console.log('✓ 通过：看不到金额的角色，接口与导出里都没有金额字段')
}

await main()
