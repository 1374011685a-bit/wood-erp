# 立川木业木材管理系统（骨架）

单机本地运行的最简骨架，不含登录、权限、数据库与业务逻辑，页面均为“开发中”占位。

## 技术栈

- 前端：Vite + React + TypeScript + react-router-dom
- 后端：Node + Express（后续可接入 better-sqlite3）

## 环境要求

- Node.js 20 及以上
- 包管理器：npm（使用 pnpm 时命令等价，如 `pnpm run dev`）

## 首次安装

```bash
npm install        # 安装根依赖（concurrently）
npm run install:all  # 依次安装 client 与 server 依赖
```

## 启动开发环境

```bash
npm run dev
```

- 前端：http://localhost:5173
- 后端：http://localhost:3001
- 接口自测：http://localhost:5173/api/ping 返回 `{"ok":true}`

前端 5173 的 `/api` 请求由 Vite 代理到后端 3001，因此前端代码里直接写 `/api/xxx` 即可。

## 目录结构

```
wood-erp/
├── client/                 # 前端
│   ├── index.html
│   ├── vite.config.ts      # 端口 5173，/api 代理到 3001
│   └── src/
│       ├── App.tsx         # 路由表
│       ├── components/     # Layout（左侧导航）、Placeholder（开发中占位）
│       └── pages/          # Home / Inbound / Outbound / Stock / Records
├── server/                 # 后端
│   ├── index.js            # Express 入口：initDB() + GET /api/ping
│   ├── db.js               # better-sqlite3 实例与 initDB() 建表；库文件 data.db（已 gitignore）
│   ├── routes/             # inbound / outbound / stock / records（骨架，暂无接口）
│   └── utils/cubic.js      # 立方计算 calcCubic / 金额计算 calcAmount
└── package.json            # 根，用 concurrently 同时启动前后端
```

## 立方计算

单位：厚度 mm、宽度 mm、长度 m、片数（每件片数）、件数。

```js
import { calcCubic, calcAmount } from './utils/cubic.js'

const cubic = calcCubic(38, 150, 4, 6, 100) // 13.68 m³
const amount = calcAmount(cubic, 2100) // 28728 元
```

公式为 `厚度 × 宽度 × 长度 × 片数 × 件数 ÷ 1,000,000`，即 mm × mm × m → m³。
立方保留 4 位小数，金额保留 2 位小数，均以 Number 返回。

## 数据层

- 库文件：`server/data.db`（WAL 模式，已在 .gitignore 中）
- `initDB()` 幂等建表，共 3 张：`inbound_orders`、`outbound_orders`、`order_items`
- `order_items.order_type` 用 `in` / `out` 区分出入库，并有 CHECK 约束
- `cubic` 与 `amount` 在写入时算好存库，查询时直接读取

## 后续开发

1. 在 `server/routes/` 中按模块实现接口（写库时用 `calcCubic` / `calcAmount` 算好再存）。
2. 把 `client/src/pages/` 下的占位页替换为实际页面。
3. 需要共享类型时，可在 `client/src/types` 中补充前后端约定的数据结构。
