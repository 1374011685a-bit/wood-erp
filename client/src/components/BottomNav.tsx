import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'

/**
 * 手机端的底部 Tab 栏（< 768px）。
 *
 * PC 端完全不显示 —— 基类就是 `display: none`，只有移动端媒体查询里才铺开；
 * 桌面端照旧用左侧边栏 + 顶部栏，一点没动。
 *
 * 4 个 Tab 各指向一个「入口页」：
 *   首页 `/` · 单据 `/documents` · 库存 `/stock` · 我的 `/me`
 */
type Tab = { to: string; label: string; end?: boolean; icon: ReactNode }

const TABS: Tab[] = [
  {
    to: '/',
    label: '首页',
    end: true,
    icon: <path d="M3.6 10.6 12 3.5l8.4 7.1V20a1 1 0 0 1-1 1h-4.9v-5.4H9.5V21H4.6a1 1 0 0 1-1-1z" />,
  },
  {
    to: '/documents',
    label: '单据',
    icon: (
      <>
        <path d="M6.6 3.5h7.1l4.3 4.3v12.7H6.6z" />
        <path d="M13.6 3.5v4.4h4.4" />
        <path d="M9.4 12.6h5.2M9.4 16.1h5.2" />
      </>
    ),
  },
  {
    to: '/stock',
    label: '库存',
    icon: (
      <>
        <path d="M3.7 7.5 12 3.4l8.3 4.1L12 11.6z" />
        <path d="M3.7 7.5v9.1l8.3 4 8.3-4V7.5" />
        <path d="M12 11.6v9" />
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

export default function BottomNav() {
  return (
    <nav className="bottom-nav" aria-label="主导航">
      {TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end}
          className={({ isActive }) =>
            isActive ? 'bottom-nav-item is-active' : 'bottom-nav-item'
          }
        >
          <svg
            className="bottom-nav-icon"
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
        </NavLink>
      ))}
    </nav>
  )
}
