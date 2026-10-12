// ⚠️ 唯一允许的静态 import：boot-log 会在任何其它模块加载之前先同步打一行 [boot]，
// 并挂上 uncaughtException / unhandledRejection 兜底。
import { writeLog } from './boot-log.js'

/**
 * 其余依赖全部用「动态 import + 逐步日志」加载。
 *
 * 为什么不写成「import 一行、writeLog 一行」：ESM 的 import 是静态声明，会被提升到
 * 模块体之前 —— 模块图先整体链接、所有依赖先全部求值，然后才执行本模块的语句。
 * 一旦中间某个依赖加载失败，后面的日志一行都打不出来，也定位不到是哪个模块。
 * 动态 import 是真正的运行时边界，崩在第几个模块一目了然。
 */
async function load(label, loader) {
  writeLog(`[load] … 正在加载 ${label}`)
  try {
    const mod = await loader()
    writeLog(`[load] ✓ ${label}`)
    return mod
  } catch (err) {
    writeLog(`[启动失败] 加载 ${label} 失败：\n${err?.stack ?? err}`)
    process.exit(1)
  }
}

const crypto = await load('node:crypto', () => import('node:crypto'))
const fs = await load('node:fs', () => import('node:fs'))
const path = await load('node:path', () => import('node:path'))
const { fileURLToPath } = await load('node:url', () => import('node:url'))
const dotenv = await load('dotenv', async () => (await import('dotenv')).default)
const express = await load('express', async () => (await import('express')).default)

// 数据库模块（内部会打 sql.js 初始化、落盘等日志）
const { dbPath, initDB } = await load('./db.js', () => import('./db.js'))

// 中间件与各业务路由
const { requireAuth } = await load('./middleware/auth.js', () =>
  import('./middleware/auth.js'),
)
const authRouter = await load('./routes/auth.js', async () =>
  (await import('./routes/auth.js')).default,
)
const exportRouter = await load('./routes/export.js', async () =>
  (await import('./routes/export.js')).default,
)
const homeRouter = await load('./routes/home.js', async () =>
  (await import('./routes/home.js')).default,
)
const inboundRouter = await load('./routes/inbound.js', async () =>
  (await import('./routes/inbound.js')).default,
)
const outboundRouter = await load('./routes/outbound.js', async () =>
  (await import('./routes/outbound.js')).default,
)
const stockRouter = await load('./routes/stock.js', async () =>
  (await import('./routes/stock.js')).default,
)
const recordsRouter = await load('./routes/records.js', async () =>
  (await import('./routes/records.js')).default,
)
const countRouter = await load('./routes/count.js', async () =>
  (await import('./routes/count.js')).default,
)

writeLog('[load] 全部模块加载完成')

const app = express()

function fatal(message) {
  writeLog(`[启动失败] ${message}`)
  process.exit(1)
}

// 无论从哪个目录启动，都读 server/.env
const serverDir = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(serverDir, '.env'), quiet: true })

// JWT_SECRET：没配置时给一个随机的临时密钥，保证容器能起来（重启后登录态失效）
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex')
  writeLog(
    '[警告] 未配置 JWT_SECRET，本次启动使用随机临时密钥：重启后所有登录态失效。\n' +
      '        请在平台的环境变量里配置一个固定的 32 位以上随机串（本地写在 server/.env）。',
  )
}

const PORT = Number(process.env.PORT) || 3001
// 监听所有网卡，容器里必须这样，否则健康检查连不上
const HOST = process.env.HOST || '0.0.0.0'

try {
  initDB()
} catch (err) {
  fatal(
    `数据库初始化失败：${err?.message ?? err}\n` +
      `        数据库文件：${dbPath}\n` +
      `        DATA_DIR：${process.env.DATA_DIR ?? '（未设置，使用 server 目录）'}`,
  )
}
writeLog(`数据库初始化成功：${dbPath}`)

app.use(express.json())

// 认证接口：login 公开，me / change-password 在路由内部各自校验
app.use('/api/auth', authRouter)

// 健康检查（同样需要登录）
app.get('/api/ping', requireAuth, (_req, res) => {
  res.json({ ok: true })
})

// 业务路由：统一走登录校验
app.use('/api/export', requireAuth, exportRouter)
app.use('/api/home', requireAuth, homeRouter)
app.use('/api/inbound', requireAuth, inboundRouter)
app.use('/api/outbound', requireAuth, outboundRouter)
app.use('/api/stock', requireAuth, stockRouter)
app.use('/api/records', requireAuth, recordsRouter)
app.use('/api/count', requireAuth, countRouter)

// 生产模式：同时把前端构建产物当静态资源服务（先执行 cd client && pnpm build）
const clientDist = path.join(serverDir, '..', 'client', 'dist')

if (!fs.existsSync(path.join(clientDist, 'index.html'))) {
  writeLog(
    `[警告] 没有找到前端构建产物：${clientDist}/index.html，页面会 404（生产镜像请先执行 cd client && pnpm build）`,
  )
}

app.use(
  express.static(clientDist, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('index.html')) {
        // index.html 不缓存：否则前端更新后，浏览器还在用旧页面引用已删除的旧资源
        res.setHeader('Cache-Control', 'no-cache')
      } else if (/\.(js|css|woff2?|png|jpe?g|svg|webp)$/.test(filePath)) {
        // 带内容哈希的静态资源，可以长期缓存
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      }
    },
  }),
)

// 前端路由兜底：非 /api 的 GET 请求一律返回 index.html，刷新子路由不会 404
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api')) return next()
  res.sendFile(
    path.join(clientDist, 'index.html'),
    { headers: { 'Cache-Control': 'no-cache' } },
    (err) => {
      if (err) next()
    },
  )
})

const server = app.listen(PORT, HOST, () => {
  writeLog(`[server] 已启动，监听 ${HOST}:${PORT}`)
  writeLog(`[server] 数据库：${dbPath}`)
  writeLog(`[server] 前端静态目录：${clientDist}`)
})

// 监听失败（端口被占用等）不会走进 console，必须显式兜住，否则只能看到容器退出
server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    fatal(`端口 ${PORT} 已被占用：请修改 PORT 环境变量或停掉占用它的进程`)
  }
  fatal(`服务监听失败（${HOST}:${PORT}）：${err?.message ?? err}`)
})
