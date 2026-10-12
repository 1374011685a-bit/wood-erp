import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import express from 'express'
import { initDB } from './db.js'
import { requireAuth } from './middleware/auth.js'
import authRouter from './routes/auth.js'
import exportRouter from './routes/export.js'
import homeRouter from './routes/home.js'
import inboundRouter from './routes/inbound.js'
import outboundRouter from './routes/outbound.js'
import stockRouter from './routes/stock.js'
import recordsRouter from './routes/records.js'

const app = express()

// 无论从哪个目录启动，都读 server/.env
const serverDir = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(serverDir, '.env'), quiet: true })

if (!process.env.JWT_SECRET) {
  console.error(
    '缺少 JWT_SECRET：本地请在 server/.env 配置，部署到 Railway 请在 Variables 里配置',
  )
  process.exit(1)
}

const PORT = Number(process.env.PORT) || 3001

initDB()
console.log('数据库初始化成功')

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
app.use(express.static(clientDist))

// 前端路由兜底：非 /api 的 GET 请求一律返回 index.html，刷新子路由不会 404
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api')) return next()
  res.sendFile(path.join(clientDist, 'index.html'), (err) => {
    if (err) next()
  })
})

app.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}`)
})
