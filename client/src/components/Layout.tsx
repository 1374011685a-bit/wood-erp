import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  changePassword,
  clearSession,
  getStoredUsername,
  resetPassword,
} from '../api'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { ToastHost, type ToastItem } from './Ui'

type NavItem = {
  to: string
  label: string
  end?: boolean
  icon: ReactNode
}

/** 首页独立放最上面，不归到任何分类里 */
const homeItem: NavItem = {
  to: '/',
  label: '首页',
  end: true,
  icon: <path d="M3 10.6 12 3l9 7.6V20a1 1 0 0 1-1 1h-5.5v-6h-5v6H4a1 1 0 0 1-1-1z" />,
}

type NavGroup = {
  key: string
  label: string
  hint: string
  items: NavItem[]
}

/** 按业务归类：点分组标题可以展开 / 收起 */
const navGroups: NavGroup[] = [
  {
    key: 'purchase',
    label: '采购',
    hint: '向供应商进货',
    items: [
      {
    to: '/inbound',
    label: '入库',
    icon: (
      <>
        <path d="M12 3v10" />
        <path d="m8 9 4 4 4-4" />
        <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
      </>
    ),
      },
    ],
  },
  {
    key: 'sale',
    label: '销售',
    hint: '发货给客户',
    items: [
      {
    to: '/outbound',
    label: '出库',
    icon: (
      <>
        <path d="M12 13V3" />
        <path d="m8 7 4-4 4 4" />
        <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
      </>
    ),
      },
    ],
  },
  {
    key: 'stock',
    label: '仓库',
    hint: '库存与盘点',
    items: [
      {
    to: '/stock',
    label: '库存',
    icon: (
      <>
        <path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z" />
        <path d="M3 7.5 12 12l9-4.5" />
        <path d="M12 12v9" />
      </>
    ),
      },
      {
    to: '/count',
    label: '盘点',
    icon: (
      <>
        <path d="M9 4.5h6a1 1 0 0 1 1 1v1H8v-1a1 1 0 0 1 1-1z" />
        <path d="M6.5 6.5h11v12a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2z" />
        <path d="m9.6 13.4 1.7 1.7 3.4-3.6" />
      </>
    ),
      },
      {
    to: '/records',
    label: '流水',
    icon: (
      <>
        <path d="M8 6h13M8 12h13M8 18h13" />
        <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
      </>
    ),
      },
    ],
  },
  {
    key: 'finance',
    label: '财务',
    hint: '应收应付与对账',
    items: [
      {
    to: '/settlement',
    label: '对账',
    icon: (
      <>
        <path d="M6.8 3.6h6.9l4.5 4.5v12.3H6.8z" />
        <path d="M13.4 3.6v4.8h4.8" />
        <path d="m9.9 12.3 2.1 2.4 2.1-2.4" />
        <path d="M12 14.7v4" />
        <path d="M9.9 15.9h4.2M9.9 17.3h4.2" />
      </>
    ),
      },
    ],
  },
  {
    key: 'system',
    label: '系统',
    hint: '已删除的单据',
    items: [
      {
    to: '/recycle',
    label: '回收站',
    icon: (
      <>
        <path d="M4 6.5h16" />
        <path d="M9.5 6.5V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5" />
        <path d="M6.5 6.5 7.4 19a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5l.9-12.5" />
        <path d="M10.2 10.5v6M13.8 10.5v6" />
      </>
    ),
      },
    ],
  },
]

const navItems: NavItem[] = [homeItem, ...navGroups.flatMap((group) => group.items)]

/** 路由 → 标签名（和左侧菜单同名） */
function labelOf(path: string) {
  const hit = navItems.find((item) => item.to === path)
  if (hit) return hit.label
  return path.replace(/^\//, '') || '首页'
}

export default function Layout() {
  const navigate = useNavigate()
  const location = useLocation()
  // 打开的功能标签（点一个功能就像开一个网页，可以来回切、可以关）
  const [tabs, setTabs] = useState<{ path: string; label: string }[]>(() => [
    location.pathname === '/'
      ? null
      : { path: location.pathname, label: labelOf(location.pathname) },
  ].filter(Boolean) as { path: string; label: string }[])
  // RequireAuth 校验通过后会把用户名写进 localStorage，这里读一次即可
  const [username] = useState(() => getStoredUsername())
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [useResetCode, setUseResetCode] = useState(false)
  const [resetCode, setResetCode] = useState('')
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<ToastItem | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const accountRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  // 分组默认全展开，点标题可以收起；切到某个功能时会自动把它所在的分组展开
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(navGroups.map((group) => [group.key, true])),
  )

  // 点击空白处收起账号菜单（苹果的菜单行为）
  useEffect(() => {
    if (!menuOpen) return

    const handlePointerDown = (event: MouseEvent) => {
      if (!accountRef.current?.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [menuOpen])

  useEscapeKey(menuOpen, () => setMenuOpen(false))
  useEscapeKey(passwordOpen, () => setPasswordOpen(false))

  // 切到没打开过的功能就补一个标签（首页不做索引）
  useEffect(() => {
    if (location.pathname === '/') return
    setTabs((prev) =>
      prev.some((tab) => tab.path === location.pathname)
        ? prev
        : [...prev, { path: location.pathname, label: labelOf(location.pathname) }],
    )
  }, [location.pathname])

  // 当前功能所在的分组要是被收起了，进来时自动展开
  useEffect(() => {
    const group = navGroups.find((item) =>
      item.items.some((entry) => entry.to === location.pathname),
    )
    if (!group) return
    setOpenGroups((prev) => (prev[group.key] ? prev : { ...prev, [group.key]: true }))
  }, [location.pathname])

  // 关标签：关掉当前页就切到左边那个（没有就切到第一个）
  const closeTab = (path: string) => {
    const next = tabs.filter((tab) => tab.path !== path)
    setTabs(next)

    if (path === location.pathname) {
      if (next.length === 0) {
        navigate('/')
        return
      }
      const index = tabs.findIndex((tab) => tab.path === path)
      const target = next[Math.min(Math.max(index - 1, 0), next.length - 1)] ?? next[0]
      navigate(target.path)
    }
  }

  // 菜单一打开就把焦点交给第一项，键盘可以直接上下选、回车确认
  useEffect(() => {
    if (!menuOpen) return
    menuRef.current?.querySelector<HTMLButtonElement>('.account-menu-item')?.focus()
  }, [menuOpen])

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return

    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('.account-menu-item') ?? [],
    )
    if (items.length === 0) return

    event.preventDefault()
    const step = event.key === 'ArrowDown' ? 1 : -1
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = (current + step + items.length) % items.length
    items[next]?.focus()
  }

  const initial = (username.trim().charAt(0) || 'U').toUpperCase()

  const handleLogout = () => {
    clearSession()
    navigate('/login', { replace: true })
  }

  const openPassword = () => {
    setOldPassword('')
    setNewPassword('')
    setResetCode('')
    setUseResetCode(false)
    setPasswordOpen(true)
  }

  const submitPassword = async () => {
    setSaving(true)
    try {
      if (useResetCode) {
        await resetPassword({
          username: username || 'admin',
          resetCode,
          newPassword,
        })
      } else {
        await changePassword(oldPassword, newPassword)
      }
      setPasswordOpen(false)
      setToast({
        id: 'password-changed',
        kind: 'success',
        message: useResetCode
          ? '密码已通过重置口令修改，下次请用新密码登录'
          : '密码已修改，下次请用新密码登录',
        onClose: () => setToast(null),
      })
    } catch (err) {
      setToast({
        id: 'password-error',
        kind: 'error',
        message: err instanceof Error ? err.message : '修改失败',
        onClose: () => setToast(null),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-brand">立川木业木材管理系统</div>
        <nav className="sidebar-nav">
          {/* 首页独立，不归到任何分类里 */}
          <NavLink
            to={homeItem.to}
            end={homeItem.end}
            className={({ isActive }) =>
              isActive ? 'nav-item nav-item-active' : 'nav-item'
            }
          >
            <svg
              className="nav-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {homeItem.icon}
            </svg>
            <span>{homeItem.label}</span>
          </NavLink>

          {navGroups.map((group) => {
            const open = Boolean(openGroups[group.key])
            return (
              <div key={group.key} className={open ? 'nav-group is-open' : 'nav-group'}>
                <button
                  type="button"
                  className="nav-group-head"
                  aria-expanded={open}
                  title={group.hint}
                  onClick={() =>
                    setOpenGroups((prev) => ({ ...prev, [group.key]: !prev[group.key] }))
                  }
                >
                  <span className="nav-group-label">{group.label}</span>
                  <svg className="nav-group-chevron" viewBox="0 0 8 8" aria-hidden="true">
                    <path
                      d="M2.6 1.4 5.4 4l-2.8 2.6"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>

                <div className="nav-group-body">
                  <div className="nav-group-inner">
                    {group.items.map((item) => (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        end={item.end}
                        className={({ isActive }) =>
                          isActive ? 'nav-item nav-item-active' : 'nav-item'
                        }
                      >
                        <svg
                          className="nav-icon"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          {item.icon}
                        </svg>
                        <span>{item.label}</span>
                      </NavLink>
                    ))}
                  </div>
                </div>
              </div>
            )
          })}
        </nav>
      </aside>
      <main className="content">
        <div className="topbar">
          <div className="account" ref={accountRef}>
            <button
              type="button"
              className={menuOpen ? 'account-trigger account-trigger-open' : 'account-trigger'}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <span className="account-avatar" aria-hidden="true">
                {initial}
              </span>
              <span className="account-name">{username}</span>
              <svg
                className="account-chevron"
                viewBox="0 0 10 6"
                aria-hidden="true"
              >
                <path
                  d="M1 1.2 5 5 9 1.2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>

            {menuOpen && (
              <div
                className="account-menu"
                role="menu"
                ref={menuRef}
                onKeyDown={handleMenuKeyDown}
              >
                <button
                  type="button"
                  className="account-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    openPassword()
                  }}
                >
                  <svg
                    className="account-menu-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <rect x="4.5" y="10.5" width="15" height="9.5" rx="2.6" />
                    <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" />
                    <path d="M12 14.2v2.4" />
                  </svg>
                  <span>修改密码</span>
                </button>
                <div className="account-menu-sep" />
                <button
                  type="button"
                  className="account-menu-item account-menu-item-danger"
                  role="menuitem"
                  onClick={handleLogout}
                >
                  <svg
                    className="account-menu-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M14.5 4h3.6A1.9 1.9 0 0 1 20 5.9v12.2a1.9 1.9 0 0 1-1.9 1.9h-3.6" />
                    <path d="M9.8 8.2 6 12l3.8 3.8" />
                    <path d="M6.4 12H15" />
                  </svg>
                  <span>退出登录</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* 功能索引：点开过的功能都在这里，像浏览器标签一样切换（首页不做索引） */}
        {tabs.length > 0 && (
        <nav className="tabbar" aria-label="已打开的功能">
          {tabs.map((tab) => (
            <div
              key={tab.path}
              className={
                tab.path === location.pathname ? 'tab-item tab-item-active' : 'tab-item'
              }
            >
              <button
                type="button"
                className="tab-label"
                onClick={() => navigate(tab.path)}
              >
                {tab.label}
              </button>
              <button
                type="button"
                className="tab-close"
                aria-label={`关闭 ${tab.label}`}
                onClick={() => closeTab(tab.path)}
              >
                ×
              </button>
            </div>
          ))}
        </nav>
        )}

        <Outlet />
      </main>

      {passwordOpen && (
        <div className="overlay" onClick={() => setPasswordOpen(false)}>
          <div
            className="modal modal-narrow modal-sheet"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <h2 className="modal-title">修改密码</h2>
              <button
                className="btn btn-sm btn-quiet"
                onClick={() => setPasswordOpen(false)}
              >
                关闭
              </button>
            </div>

            {useResetCode ? (
              <label className="field">
                <span>重置口令</span>
                <input
                  className="input"
                  type="password"
                  value={resetCode}
                  autoComplete="off"
                  onChange={(event) => setResetCode(event.target.value)}
                />
              </label>
            ) : (
              <label className="field">
                <span>原密码</span>
                <input
                  className="input"
                  type="password"
                  value={oldPassword}
                  autoComplete="current-password"
                  onChange={(event) => setOldPassword(event.target.value)}
                />
              </label>
            )}

            <label className="field" style={{ marginTop: 14 }}>
              <span>新密码（至少 6 位）</span>
              <input
                className="input"
                type="password"
                value={newPassword}
                autoComplete="new-password"
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </label>

            <div className="confirm-actions" style={{ marginTop: 22 }}>
              <button className="btn" onClick={() => setPasswordOpen(false)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void submitPassword()}
                disabled={saving}
              >
                {saving ? '保存中…' : '保存'}
              </button>
            </div>

            <button
              type="button"
              className="login-forgot"
              style={{ display: 'block', marginTop: 12 }}
              onClick={() => {
                setUseResetCode((prev) => !prev)
                setResetCode('')
                setOldPassword('')
              }}
            >
              {useResetCode ? '改回用原密码修改' : '忘记原密码？用重置口令修改'}
            </button>
          </div>
        </div>
      )}

      <ToastHost items={[toast]} />
    </div>
  )
}
