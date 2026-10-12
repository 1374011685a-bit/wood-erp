import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import {
  changePassword,
  clearSession,
  getStoredUsername,
} from '../api'
import { ToastHost, type ToastItem } from './Ui'

type NavItem = {
  to: string
  label: string
  end?: boolean
}

const navItems: NavItem[] = [
  { to: '/', label: '首页', end: true },
  { to: '/inbound', label: '入库' },
  { to: '/outbound', label: '出库' },
  { to: '/stock', label: '库存' },
  { to: '/records', label: '流水' },
]

export default function Layout() {
  const navigate = useNavigate()
  // RequireAuth 校验通过后会把用户名写进 localStorage，这里读一次即可
  const [username] = useState(() => getStoredUsername())
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<ToastItem | null>(null)

  const handleLogout = () => {
    clearSession()
    navigate('/login', { replace: true })
  }

  const openPassword = () => {
    setOldPassword('')
    setNewPassword('')
    setPasswordOpen(true)
  }

  const submitPassword = async () => {
    setSaving(true)
    try {
      await changePassword(oldPassword, newPassword)
      setPasswordOpen(false)
      setToast({
        id: 'password-changed',
        kind: 'success',
        message: '密码已修改，下次请用新密码登录',
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
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="content">
        <div className="topbar">
          <span className="topbar-user">{username}</span>
          <button className="btn btn-sm" onClick={openPassword}>
            修改密码
          </button>
          <button className="btn btn-sm btn-danger" onClick={handleLogout}>
            退出登录
          </button>
        </div>

        <Outlet />
      </main>

      {passwordOpen && (
        <div className="overlay" onClick={() => setPasswordOpen(false)}>
          <div
            className="modal modal-narrow"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <h2 className="modal-title">修改密码</h2>
              <button className="btn" onClick={() => setPasswordOpen(false)}>
                关闭
              </button>
            </div>

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
          </div>
        </div>
      )}

      <ToastHost items={[toast]} />
    </div>
  )
}
