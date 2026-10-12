// ⚠️ 这一行必须保持在所有 import 的最前面：boot-log 会先同步打一行 [boot] 日志并挂兜底处理器
import { writeLog } from './boot-log.js'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import express from 'express'
import { dbPath, initDB } from './db.js'
import { requireAuth } from './middleware/auth.js'
import authRouter from './routes/auth.js'
import exportRouter from './routes/export.js'
import homeRouter from './routes/home.js'
import inboundRouter from './routes/inbound.js'
import outboundRouter from './routes/outbound.js'
import stockRouter from './routes/stock.js'
import recordsRouter from './routes/records.js'

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
console.log(`数据库初始化成功：${dbPath}`)

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

// 生产模式：同时把前端构建产物当静态资源服务（先执行 cd client && pnpm build）
const clientDist = path.join(serverDir, '..', 'client', 'dist')

if (!fs.existsSync(path.join(clientDist, 'index.html'))) {
  writeLog(
    `[警告] 没有找到前端构建产物：${clientDist}/index.html，页面会 404（生产镜像请先执行 cd client && pnpm build）`,
  )
}

app.use(express.static(clientDist))

// 前端路由兜底：非 /api 的 GET 请求一律返回 index.html，刷新子路由不会 404
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api')) return next()
  res.sendFile(path.join(clientDist, 'index.html'), (err) => {
    if (err) next()
  })
})

const server = app.listen(PORT, HOST, () => {
  console.log(`[server] 已启动，监听 ${HOST}:${PORT}`)
  console.log(`[server] 数据库：${dbPath}`)
  console.log(`[server] 前端静态目录：${clientDist}`)
})

// 监听失败（端口被占用等）不会走进 console，必须显式兜住，否则只能看到容器退出
server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    fatal(`端口 ${PORT} 已被占用：请修改 PORT 环境变量或停掉占用它的进程`)
  }
  fatal(`服务监听失败（${HOST}:${PORT}）：${err?.message ?? err}`)
})
