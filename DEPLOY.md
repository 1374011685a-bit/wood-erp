# 部署到 Railway（中文手把手指南）

本项目是「前端 Vite + React，后端 Node + Express + better-sqlite3」的单仓库（monorepo）结构，
生产模式下**后端会同时把前端的构建产物当静态资源服务**，所以线上只有一个服务、一个端口。

```
wood-erp/
├── client/       前端（Vite + React），构建产物在 client/dist
├── server/       后端（Express），生产时同时托管 client/dist
├── package.json  根：dev / build / start 脚本
└── nixpacks.toml Railway 的构建配置（装依赖、构建前端、启动后端）
```

---

## 1. 前置准备

1. 注册 [GitHub](https://github.com) 账号。
2. 注册 [Railway](https://railway.app) 账号（直接选 **Login with GitHub**，省一步绑定）。

本地需要装好：

| 工具 | 说明 |
| --- | --- |
| Git | 推代码用 |
| Node.js 20+ | 本地跑构建用（线上由 Railway 提供 Node 22） |
| pnpm | 本项目的包管理器（`npm i -g pnpm` 或 `corepack enable`） |

---

## 2. 把代码推上 GitHub

在项目根目录（就是含 `client/`、`server/`、`package.json` 的那一层）执行：

```bash
git init
git add .
git commit -m "初始化：立川云木材管理系统"
```

然后去 GitHub 新建一个**空仓库**（不要勾选 Add README / .gitignore / license，否则推送会冲突），
拿到仓库地址后在本地执行：

```bash
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git branch -M main
git push -u origin main
```

推送前确认一下 `server/.env` 没有被提交（`.gitignore` 已经排除它）：

```bash
git status --short          # 不应该出现 server/.env
git ls-files server/.env    # 应该没有任何输出
```

---

## 3. Railway 部署

1. 打开 Railway → **New Project** → **Deploy from GitHub repo** → 选你刚推的仓库。
   （第一次需要授权 Railway 访问 GitHub，允许即可。）
2. 进入这个服务的 **Variables**，添加两个变量：

   | 变量名 | 值 | 说明 |
   | --- | --- | --- |
   | `JWT_SECRET` | 随机 32 位以上字符串 | 登录 token 的签名密钥，**必填**，不填服务会启动失败 |
   | `DATA_DIR` | `/data` | SQLite 数据库目录，指向下面挂载的卷 |

   > `PORT` 不用配：Railway 会自动注入，本项目会优先使用它（本地默认 3001）。
   >
   > 生成随机串的两种办法：`node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`
   > 或者随便敲一串 32 位以上的大小写字母数字混合字符。

3. 在 **Volumes**（服务页面的 Volumes / 存储）新建一个卷，**Mount Path 填 `/data`**。
   不挂卷的话数据库每次重新部署都会清空。

4. 回到 Deployments，等构建完成（首次大约 1~3 分钟）。构建日志里会看到：
   `pnpm install` → `cd client && pnpm install` → `cd server && pnpm install` → `cd client && pnpm build` → `pnpm start`。

5. 部署成功后：**Settings → Networking → Generate Domain**，得到形如
   `https://<项目名>.up.railway.app` 的公网地址。

6. 数据库和默认账号是后端启动时自动创建的：第一次启动会在 `/data/data.db` 建表，并创建默认管理员
   `admin / admin123`（服务日志里会有一行提醒）。

---

## 4. 首次访问

1. 打开公网地址，会用登录页拦住你（没登录访问任何页面都会跳登录）。
2. 用 **admin / admin123** 登录。
3. **立刻点右上角「修改密码」**，设置你自己的密码（至少 6 位）。默认密码是公开的，必须改。
4. 改完密码后录一条入库单做验证：入库 → 新增入库 → 填品名/等级/尺寸/片数/件数 → 保存，
   然后去「库存」页刷新，应该能看到这条新规格的库存；「流水」页也能看到这条记录。
   这样能确认 `/data` 卷真的挂上了、数据写进了持久化的数据库。

---

## 5. 后续更新

本地改完代码后：

```bash
git add .
git commit -m "改动说明"
git push
```

Railway 会自动拉取并重新部署（也可以在 Railway 面板点 Redeploy 手动触发）。
数据库在 `/data` 卷里，重新部署不会丢。

> 注意：改了 `server/db.js` 里建表语句才会影响表结构；本项目目前靠 `initDB()` 幂等建表，
> 新增表/字段会自动创建，不会清空已有数据。

---

## 6. 常见问题

**Q1：数据重启后就没了？**
按顺序检查三件事：
1. Railway 的 **Volumes** 里有没有卷，Mount Path 是否是 `/data`；
2. **Variables** 里 `DATA_DIR` 是否等于 `/data`；
3. Deploy Logs 里搜 `data.db`，确认数据库文件路径是 `/data/data.db`。

**Q2：部署失败 / 服务起不来？**
先看 Railway 的 **Build Logs**（构建阶段）和 **Deploy Logs**（启动阶段）：
- 构建阶段报依赖装不上：仓库里的 `pnpm-lock.yaml`（根、client、server 各一份）要一起提交，
  不要只提交源码。
- 启动阶段报 `缺少 JWT_SECRET`：Variables 里没配 `JWT_SECRET`，补上后 Redeploy。
- 本地想复现线上：见下面「本地模拟生产环境」。

**Q3：密码忘了怎么办？**
本项目目前没有找回密码功能，只能重置数据库：删掉 `/data/data.db`（或删卷）后重新部署，
系统会重新创建 `admin / admin123`，**但所有业务数据会一起丢失**。所以密码一定要记牢。

**Q4：本地能跑，线上 502？**
多半是没有 Generate Domain，或者服务崩溃后端口没起来。先看 Deploy Logs 最后 20 行，
确认有 `[server] http://localhost:<PORT>` 这行输出。

---

## 附：本地模拟生产环境

和线上走完全一样的链路（后端同时服务前端构建产物，只用一个端口 3001）：

```bash
# 1. 构建前端（产物在 client/dist）
cd client && pnpm install && pnpm build

# 2. 回到项目根目录，用生产模式启动后端
cd ..
pnpm start

# 3. 浏览器打开 http://localhost:3001（注意不是 5173）
```

自检清单：
- 打开 `http://localhost:3001` 会跳到登录页；
- 能登录（默认 admin / admin123，若已改过就用你自己的密码）；
- 首页 5 个卡片数字正常；
- 入库 / 出库 / 库存 / 流水都能打开；
- 库存页「导出 Excel」能下载到 xlsx；
- 直接刷新 `http://localhost:3001/stock`、`/records` 这类子路由，不会 404（后端已做前端路由兜底）。

日常开发仍然用两个端口的热更新模式：

```bash
pnpm run dev          # 前端 http://localhost:5173，后端 http://localhost:3001
```

## 附：环境变量一览

| 变量 | 必填 | 本地默认 | 线上（Railway） | 说明 |
| --- | --- | --- | --- | --- |
| `JWT_SECRET` | 是 | 写在 `server/.env`（已被 gitignore） | Variables 里配置 | JWT 签名密钥，≥32 位随机串 |
| `PORT` | 否 | 3001 | 不用配，Railway 自动注入 | 服务监听端口 |
| `DATA_DIR` | 否 | 不配时落在 `server/`（沿用 `server/data.db`） | `/data` | 数据库目录，配了会自动建目录 |
| `RESET_CODE` | 否 | `123` | 建议设成只有你知道的字符串 | 登录页「忘记密码」用的重置口令 |

> ⚠️ 关于「忘记密码」：登录页和顶部「修改密码」弹窗都能用重置口令直接把密码改掉。
> 这是单机部署的过渡方案，**一定要把 `RESET_CODE` 从默认的 123 改掉**；
> 连续 5 次输错会被限流 10 分钟，每次尝试都会写日志（`[auth] 重置口令校验失败…`）。
> 另一种重置方式（不需要服务在跑）：`node server/reset-password.js` 生成一个随机新密码。

---

## 附：Docker 镜像（推到 GitHub 后自动构建）

仓库根目录有 `Dockerfile`（多阶段构建：build 阶段装依赖 + 构建前端，runtime 阶段只留生产依赖）
和 `.github/workflows/docker.yml`（push 到 `main` 自动构建）。推上去之后镜像地址是：

```
ghcr.io/1374011685a-bit/wood-erp:latest
```

**第一次推送后还需要做一件事**：GHCR 的 package 默认是私有的，必须手动改成公开，
否则 Sealos 这类平台拉取会报 401（仓库是 public 不代表镜像 package 是 public）：

> GitHub → 右上角头像 → **Your profile** → **Packages** → `wood-erp` →
> 右侧 **Package settings** → 拉到底 **Danger Zone** → **Change visibility** → 选 **Public**

镜像里的约定：

| 项 | 值 |
| --- | --- |
| 端口 | `3001`（可用 `-e PORT=` 覆盖，平台一般会自己注入） |
| 数据库目录 | `/data`（**必须挂卷**，否则容器删了数据就没了） |
| `JWT_SECRET` | 没有默认值，必须通过环境变量传入，否则容器启动即退出 |

本地构建并运行镜像：

```bash
docker build -t wood-erp .

docker run -d --name wood-erp -p 3001:3001 \
  -e JWT_SECRET=<32位以上随机串> \
  -e DATA_DIR=/data \
  -v wood-erp-data:/data \
  wood-erp

# 打开 http://localhost:3001，用 admin / admin123 登录后立刻改密码
```
