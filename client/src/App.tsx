import { Suspense, lazy } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import RequireAuth from './components/RequireAuth'

/**
 * 页面按需加载：首屏只下载登录页和外壳，
 * 点到哪个功能才拉那个页面的代码（表单页最大，省下来的就是首屏时间）。
 */
const Login = lazy(() => import('./pages/Login'))
const Home = lazy(() => import('./pages/Home'))
const Inbound = lazy(() => import('./pages/Inbound'))
const Outbound = lazy(() => import('./pages/Outbound'))
const Stock = lazy(() => import('./pages/Stock'))
const Count = lazy(() => import('./pages/Count'))
const Repack = lazy(() => import('./pages/Repack'))
const Contracts = lazy(() => import('./pages/Contracts'))
const Bales = lazy(() => import('./pages/Bales'))
const Records = lazy(() => import('./pages/Records'))
const Recycle = lazy(() => import('./pages/Recycle'))
const Settlement = lazy(() => import('./pages/Settlement'))
const Dict = lazy(() => import('./pages/Dict'))

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
              <Layout />
            </RequireAuth>
          }
        >
          <Route index element={<Home />} />
          <Route path="inbound" element={<Inbound defaultMode="list" />} />
          <Route path="outbound" element={<Outbound />} />
          <Route path="stock" element={<Stock />} />
          <Route path="count" element={<Count />} />
          <Route path="repack" element={<Repack />} />
          <Route path="contracts" element={<Contracts />} />
          <Route path="bales" element={<Bales />} />
          <Route path="records" element={<Records />} />
          <Route path="recycle" element={<Recycle />} />
          <Route path="settlement" element={<Settlement />} />
          <Route path="dict" element={<Dict />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
