/**
 * 手机端外壳（第 2 刀）：顶栏 + 底部 Tab + 安全区。
 *
 * ⚠️ 只被 `App.tsx` 的**白名单路由**使用：手机端打开这几个路径才走这棵树，
 *    其它页面（库存 / 合同 / 改包 / 流水 / 我的…）继续走老的 Desktop Layout，
 *    桌面端（≥768px）永远走老树 —— 所以桌面端一个像素都不会变。
 */
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { goBack } from './nav'

type Tab = { to: string; label: string; icon: ReactNode }

const TABS: Tab[] = [
  {
    to: '/',
    label: '首页',
    icon: (
      <path d="M3.6 10.6 12 3.5l8.4 7.1V20a1 1 0 0 1-1 1h-4.9v-5.4H9.5V21H4.6a1 1 0 0 1-1-1z" />
    ),
  },
  {
    to: '/documents',
    label: '单据',
    icon: (
      <>
        <path d="M6.6 3.5h7.1l4.3 4.3v12.7H6.6z" />
        <path d="M13.6 3.5v4.4h4.4M9.4 12.6h5.2M9.4 16.1h5.2" />
      </>
    ),
  },
  {
    to: '/stock',
    label: '库存',
    icon: (
      <>
        <path d="M3.7 7.5 12 3.4l8.3 4.1L12 11.6z" />
        <path d="M3.7 7.5v9.1l8.3 4 8.3-4V7.5M12 11.6v9" />
      </>
    ),
  },
  {
    to: '/me',
    label: '我的',
    icon: (
      <>
        <circle cx="12" cy="8.3" r="3.9" />
        <path d="M4.9 20.3c.7-3.6 3.6-5.7 7.1-5.7s6.4 2.1 7.1 5.7" />
      </>
    ),
  },
]

/** 首页 / 入库 / 出库 各自的顶栏标题与返回目标 */
const META: Record<string, { title: string; back?: string }> = {
  '/': { title: '立川云' },
  '/documents': { title: '单据', back: '/' },
  '/inbound': { title: '入库单', back: '/' },
  '/inbound/new': { title: '采购入库', back: '/inbound' },
  '/outbound': { title: '出库单', back: '/' },
  '/outbound/new': { title: '出库', back: '/outbound' },
  '/stock': { title: '库存', back: '/' },
  '/records': { title: '流水', back: '/' },
  '/contracts': { title: '采购合同', back: '/' },
  '/bales': { title: '采购入库明细', back: '/' },
  '/repack': { title: '改包', back: '/' },
  '/count': { title: '盘点', back: '/' },
  '/recycle': { title: '回收站', back: '/' },
}

/** 底部 Tab 落到哪个路径 */
const TAB_PATHS = ['/', '/documents', '/stock', '/me']

/**
 * 全屏子页面：表单页。
 * 这类页面要 ① 隐藏底部 Tab（否则误点就丢未保存数据）② 任何 Tab 都不高亮。
 */
const FULLSCREEN_PATHS = ['/inbound/new', '/outbound/new']

export default function MobileLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const search = new URLSearchParams(location.search)
  const repackForm = location.pathname === '/repack' && search.get('mode') === 'new'
  const meta = repackForm
    ? { title: '新增改包', back: '/repack' }
    : (META[location.pathname] ?? { title: '立川云' })
  const activeTab =
    TAB_PATHS.find((path) => path === location.pathname) ??
    (location.pathname.startsWith('/me') ? '/me' : '/')
  const fullscreen = FULLSCREEN_PATHS.includes(location.pathname) || repackForm

  return (
    <div className="m-shell">
      <header className="m-topbar">
        <div className="m-topbar-side">
          {meta.back ? (
            <button
              type="button"
              className="m-topbar-btn"
              aria-label="返回"
              onClick={() => goBack(navigate, meta.back as string)}
            >
              <svg
                viewBox="0 0 24 24"
                width="24"
                height="24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M14.5 5.5 8 12l6.5 6.5" />
              </svg>
            </button>
          ) : null}
        </div>
        <h1 className="m-topbar-title">{meta.title}</h1>
        {/* 页面级操作（筛选 / +）通过 portal 挂到这里 */}
        <div className="m-topbar-side" data-m-topbar-actions />
      </header>

      <main className={fullscreen ? 'm-body m-body-full' : 'm-body'}>
        {/*
          二级页从右滑入（Tab 根页面不滑：那会和底部 Tab 的瞬时切换打架）。
          key 用 pathname，换页就重新挂载跑一遍动画。
        */}
        <div
          key={location.pathname}
          className={TAB_PATHS.includes(location.pathname) ? undefined : 'm-page-in'}
        >
          <Outlet />
        </div>
      </main>

      {!fullscreen && (
      <nav className="m-tabbar" aria-label="主导航">
        {TABS.map((tab) => (
          <button
            type="button"
            key={tab.to}
            className={tab.to === activeTab ? 'm-tabitem is-on' : 'm-tabitem'}
            onClick={() => navigate(tab.to)}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {tab.icon}
            </svg>
            <span>{tab.label}</span>
          </button>
        ))}
      </nav>
      )}
    </div>
  )
}
