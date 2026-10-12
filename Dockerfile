# ============================================================
# 立川木业木材管理系统 —— 生产镜像（多阶段构建）
#   阶段 1 build   ：装依赖 + 构建前端，产出 client/dist
#   阶段 2 runtime ：只留生产依赖，Node 同时提供 API 和前端静态文件
#
# 数据库用 sql.js（纯 JS + WebAssembly），没有原生模块，任何基础镜像都能跑；
# 这里用 Debian 系（slim），行为更可预期。
# 数据库文件放在 DATA_DIR（容器里默认 /data），记得挂卷。
# ============================================================

# ---------- 阶段 1：构建 ----------
FROM node:20-slim AS build
WORKDIR /app

# 仓库里的 lockfileVersion 是 9.0，用 pnpm 10 匹配
RUN npm install -g pnpm@10

# 先只复制清单文件，依赖安装这一层可以被缓存
COPY package.json pnpm-lock.yaml ./
COPY client/package.json client/pnpm-lock.yaml ./client/
COPY server/package.json server/pnpm-lock.yaml ./server/
RUN pnpm install --frozen-lockfile \
 && cd client && pnpm install --frozen-lockfile \
 && cd ../server && pnpm install --frozen-lockfile

# 复制源码，构建前端产物
COPY client ./client
COPY server ./server
RUN cd client && pnpm build

# 构建产物自检：文件不在就让构建失败，而不是拖到运行时崩
RUN ls -la /app/server/index.js /app/client/dist/index.html

# ---------- 阶段 2：运行 ----------
FROM node:20-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3001 \
    DATA_DIR=/data

# 不用 USER，默认 root 跑，避免挂载卷的权限问题
RUN npm install -g pnpm@10 && mkdir -p /data

# 基础镜像自检：node 能不能跑
RUN node -e "console.log('node works, version:', process.version)"

# 只装 server 的生产依赖（sql.js 是纯 JS + WebAssembly，不需要编译器和预编译产物）
COPY package.json ./
COPY server/package.json server/pnpm-lock.yaml ./server/
RUN cd server && pnpm install --prod --frozen-lockfile

# 运行需要的代码：后端源码 + 前端构建产物
COPY server ./server
COPY --from=build /app/client/dist ./client/dist

# 镜像自检：这几个文件缺任何一个都让构建直接失败，并在日志里打印出来
# sql.js 的 wasm 必须存在，否则运行时会起不来
RUN ls -la /app/server/index.js /app/server/boot-log.js /app/server/db.js \
 && ls -la /app/client/dist/index.html \
 && ls -la /app/server/node_modules/express/package.json \
 && ls -la /app/server/node_modules/sql.js/package.json \
 && ls -la /app/server/node_modules/sql.js/dist/sql-wasm.wasm

EXPOSE 3001

# 健康检查：不依赖 curl，用 node 自带的 fetch 打首页
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
