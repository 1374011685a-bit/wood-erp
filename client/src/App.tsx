import { Suspense, lazy } from 'react'
import type { ComponentType } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import ShellSwitch from './mobile/ShellSwitch'
import HomeMobile from './mobile/HomeMobile'
import InboundListMobile from './mobile/InboundListMobile'
import DocumentsMobile from './mobile/DocumentsMobile'
import StockMobile from './mobile/StockMobile'
import RecordsMobile from './mobile/RecordsMobile'
import OutboundListMobile from './mobile/OutboundListMobile'
import OutboundFormMobile from './mobile/OutboundFormMobile'
import InboundFormMobile from './mobile/InboundFormMobile'
import RequireAuth from './components/RequireAuth'
import RequireRole from './components/RequireRole'
import { useIsMobileViewport } from './mobile/ShellSwitch'

/**
 * 首页分流：手机端用新的 HomeMobile（白名单里唯一的页面），桌面端原样。
 * 放在 App 里而不是 Home 里，是为了让"哪棵树"这件事只有一个出口，好排查。
 */
function HomeSwitch() {
  const mobile = useIsMobileViewport()
  return mobile ? <HomeMobile /> : <Home />
}

/** 入库列表分流：手机端走新的 InboundListMobile，桌面端原样（第 2 步） */
function InboundSwitch() {
  const mobile = useIsMobileViewport()
  return mobile ? <InboundListMobile /> : <Inbound defaultMode="list" />
}

/** 单据 / 库存 / 流水 分流：手机端走 Mobile 版，桌面端原样 */
function DocumentsSwitch() {
  const mobile = useIsMobileViewport()
  return mobile ? <DocumentsMobile /> : <Documents />
}

function StockSwitch() {
  const mobile = useIsMobileViewport()
  return mobile ? <StockMobile /> : <Stock />
}

function RecordsSwitch() {
  const mobile = useIsMobileViewport()
  return mobile ? <RecordsMobile /> : <Records />
}

/** 出库列表分流：手机端走 OutboundListMobile，桌面端原样（第 3 步） */
function OutboundSwitch() {
  const mobile = useIsMobileViewport()
  return mobile ? <OutboundListMobile /> : <Outbound />
}

/** 出库表单分流：手机端走 OutboundFormMobile，桌面端原样（第 4 步） */
function OutboundNewSwitch() {
  const mobile = useIsMobileViewport()
  return mobile ? <OutboundFormMobile /> : <Outbound defaultMode="create" />
}

/** 入库表单分流：手机端走 InboundFormMobile，桌面端原样（检查点5） */
function InboundNewSwitch() {
  const mobile = useIsMobileViewport()
  return mobile ? <InboundFormMobile /> : <Inbound defaultMode="method" />
}

/**
 * 页面按需加载：首屏只下载登录页和外壳，
 * 点到哪个功能才拉那个页面的代码（表单页最大，省下来的就是首屏时间）。
 *
 * 加了「分包找不到就自动刷一次」的兜底：程序更新后，浏览器里如果还挂着旧页面，
 * 它引用的旧分包已经不存在了，会一直卡在加载中——这时自动刷新一次就能拿到新版本。
 */
function lazyPage<P extends object>(loader: () => Promise<{ default: ComponentType<P> }>) {
  return lazy(() =>
    loader().catch((err) => {
      const key = 'chunk-reloaded-at'
      const last = Number(sessionStorage.getItem(key) ?? 0)
      if (Date.now() - last > 10000) {
        sessionStorage.setItem(key, String(Date.now()))
        window.location.reload()
      }
      throw err
    }),
  )
}

const Login = lazyPage(() => import('./pages/Login'))
const Home = lazyPage(() => import('./pages/Home'))
const Inbound = lazyPage(() => import('./pages/Inbound'))
const Outbound = lazyPage(() => import('./pages/Outbound'))
const Stock = lazyPage(() => import('./pages/Stock'))
const Count = lazyPage(() => import('./pages/Count'))
const Repack = lazyPage(() => import('./pages/Repack'))
const Contracts = lazyPage(() => import('./pages/Contracts'))
const Bales = lazyPage(() => import('./pages/Bales'))
const Records = lazyPage(() => import('./pages/Records'))
const Recycle = lazyPage(() => import('./pages/Recycle'))
const Settlement = lazyPage(() => import('./pages/Settlement'))
const Dict = lazyPage(() => import('./pages/Dict'))
const LabelPrint = lazyPage(() => import('./pages/LabelPrint'))
const Users = lazyPage(() => import('./pages/Users'))
// 手机端底部 Tab 的「单据」和「我的」两个入口页
const Documents = lazyPage(() => import('./pages/Documents'))
const Me = lazyPage(() => import('./pages/Me'))
const Ai = lazyPage(() => import('./pages/Ai'))

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/login"
          element={
            <Suspense fallback={null}>
              <Login />
            </Suspense>
          }
        />
        <Route
          element={
            <RequireAuth>
              {/* 手机端白名单页面走 MobileLayout，其余（含桌面端全部）走老 Layout */}
              <ShellSwitch />
            </RequireAuth>
          }
        >
          <Route index element={<HomeSwitch />} />
          <Route path="inbound" element={<InboundSwitch />} />
          {/* 首页「新增入库 / 新增出库」直接落到录入界面 */}
          <Route path="inbound/new" element={<InboundNewSwitch />} />
          {/* 编辑某张入库单：可直接分享/跳转的地址（列表的「编辑」按钮也走这里） */}
          <Route path="inbound/edit/:id" element={<Inbound defaultMode="edit" />} />
          <Route path="outbound" element={<OutboundSwitch />} />
          <Route path="outbound/new" element={<OutboundNewSwitch />} />
          <Route path="stock" element={<StockSwitch />} />
          <Route path="count" element={<Count />} />
          <Route path="repack" element={<Repack />} />
          <Route path="contracts" element={<Contracts />} />
          <Route path="bales" element={<Bales />} />
          <Route path="records" element={<RecordsSwitch />} />
          <Route path="recycle" element={<Recycle />} />
          <Route path="settlement" element={<Settlement />} />
          <Route path="dict" element={<Dict />} />
          {/* 手机端底部 Tab 的路由（PC 端也能直接打开） */}
          <Route path="documents" element={<DocumentsSwitch />} />
          <Route path="me" element={<Me />} />
          {/* AI 助手（DeepSeek） */}
          <Route path="ai" element={<Ai />} />
          {/* 用户管理：只有管理员进得去（菜单和路由都挡，后端还有 requireCap 兜底） */}
          <Route
            path="users"
            element={
              <RequireRole allow={['admin']}>
                <Users />
              </RequireRole>
            }
          />
          {/* 打印小标签：/label/print?ids=1,2,3&size=60x40 */}
          <Route path="label/print" element={<LabelPrint />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
