import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
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

const navItems: NavItem[] = [
  {
    to: '/',
    label: '首页',
    end: true,
    icon: <path d="M3 10.6 12 3l9 7.6V20a1 1 0 0 1-1 1h-5.5v-6h-5v6H4a1 1 0 0 1-1-1z" />,
  },
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
    to: '/records',
    label: '流水',
    icon: (
      <>
        <path d="M8 6h13M8 12h13M8 18h13" />
        <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
      </>
    ),
  },
]

export default function Layout() {
  const navigate = useNavigate()
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
          {navItems.map((item) => (
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
              <div className="account-menu" role="menu">
                <button
                  type="button"
                  className="account-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    openPassword()
                  }}
                >
                  修改密码
                </button>
                <div className="account-menu-sep" />
                <button
                  type="button"
                  className="account-menu-item account-menu-item-danger"
                  role="menuitem"
                  onClick={handleLogout}
                >
                  退出登录
                </button>
              </div>
            )}
          </div>
        </div>

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
