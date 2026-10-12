# ============================================================
# 立川木业木材管理系统 —— 生产镜像（多阶段构建）
#   阶段 1 build   ：装依赖 + 构建前端，产出 client/dist
#   阶段 2 runtime ：只留生产依赖，Node 同时提供 API 和前端静态文件
# 数据库文件放在 DATA_DIR（容器里默认 /data），记得挂卷
# ============================================================

# ---------- 阶段 1：构建 ----------
FROM node:20-alpine AS build
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

# ---------- 阶段 2：运行 ----------
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3001 \
    DATA_DIR=/data

RUN npm install -g pnpm@10 && mkdir -p /data

# 只装 server 的生产依赖（better-sqlite3 自带 musl 预编译产物，不需要编译器）
COPY package.json ./
COPY server/package.json server/pnpm-lock.yaml ./server/
RUN cd server && pnpm install --prod --frozen-lockfile

# 运行需要的代码：后端源码 + 前端构建产物
COPY server ./server
COPY --from=build /app/client/dist ./client/dist

EXPOSE 3001

CMD ["node", "server/index.js"]
