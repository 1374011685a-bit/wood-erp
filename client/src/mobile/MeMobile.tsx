import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  changePassword,
  clearSession,
  getStoredUsername,
  resetPassword,
} from '../api'
import { useRole } from '../hooks/useRole'
import { ROLE_LABELS, canVisit } from '../permissions'
import { APP_BUILD_TEXT, APP_VERSION_TEXT } from '../version'
import {
  MobileAvatar,
  MobileCard,
  MobileIcon,
  MobileList,
  MobileListItem,
  MobileModal,
  MobileSheet,
  MobileToastHost,
  useAutoDismiss,
  type MobileToastItem,
} from './components'

export default function MeMobile() {
  const navigate = useNavigate()
  const role = useRole()
  const username = getStoredUsername()
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [logoutOpen, setLogoutOpen] = useState(false)
  const [useResetCode, setUseResetCode] = useState(false)
  const [form, setForm] = useState({ oldPassword: '', resetCode: '', newPassword: '' })
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<MobileToastItem | null>(null)
  useAutoDismiss(toast, () => setToast(null))

  const openPassword = () => {
    setForm({ oldPassword: '', resetCode: '', newPassword: '' })
    setUseResetCode(false)
    setPasswordOpen(true)
  }

  const savePassword = async () => {
    if (form.newPassword.length < 6) {
      setToast({ id: `p-${Date.now()}`, message: '新密码至少 6 位' })
      return
    }
    setSaving(true)
    try {
      if (useResetCode) {
        await resetPassword({
          username: username || 'admin',
          resetCode: form.resetCode,
          newPassword: form.newPassword,
        })
      } else {
        await changePassword(form.oldPassword, form.newPassword)
      }
      clearSession()
      navigate('/login', {
        replace: true,
        state: { notice: '密码已修改，请用新密码重新登录' },
      })
    } catch (err) {
      setToast({
        id: `p-${Date.now()}`,
        message: err instanceof Error ? err.message : '修改密码失败',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="m-stack">
      <MobileCard className="m-profile-card">
        <MobileAvatar name={username} />
        <div className="m-profile-text">
          <b>{username || '—'}</b>
          <span>{ROLE_LABELS[role]}</span>
        </div>
      </MobileCard>

      <MobileCard title="账号">
        <MobileList>
          <MobileListItem
            title="修改密码"
            sub="原密码或重置口令"
            icon={<MobileIcon name="user" size={20} />}
            onClick={openPassword}
          />
          <MobileListItem
            title="AI 助手"
            sub="接 DeepSeek，问库存、单据都可以"
            icon={<MobileIcon name="chart" size={20} />}
            onClick={() => navigate('/ai')}
          />
          {canVisit(role, '/dict') ? (
            <MobileListItem
              title="设置"
              sub="常用项：品名 / 等级 / 品牌"
              icon={<MobileIcon name="doc" size={20} />}
              onClick={() => navigate('/dict')}
            />
          ) : null}
          {canVisit(role, '/users') ? (
            <MobileListItem
              title="用户管理"
              sub="开号、改角色、重置密码"
              icon={<MobileIcon name="user" size={20} />}
              onClick={() => navigate('/users')}
            />
          ) : null}
        </MobileList>
      </MobileCard>

      <MobileCard title="关于">
        <div className="m-version-box">
          <span>{APP_VERSION_TEXT}</span>
          <span>{APP_BUILD_TEXT}</span>
        </div>
      </MobileCard>

      <button type="button" className="m-btn m-btn-danger m-logout-btn" onClick={() => setLogoutOpen(true)}>
        退出登录
      </button>

      <MobileSheet open={passwordOpen} title="修改密码" onClose={() => setPasswordOpen(false)}>
        <div className="m-stack-tight">
          {useResetCode ? (
            <label className="m-field">
              <span className="m-field-label">重置口令</span>
              <input
                className="m-input"
                type="password"
                value={form.resetCode}
                autoComplete="off"
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, resetCode: event.target.value }))
                }
              />
            </label>
          ) : (
            <label className="m-field">
              <span className="m-field-label">原密码</span>
              <input
                className="m-input"
                type="password"
                value={form.oldPassword}
                autoComplete="current-password"
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, oldPassword: event.target.value }))
                }
              />
            </label>
          )}
          <label className="m-field">
            <span className="m-field-label">新密码（至少 6 位）</span>
            <input
              className="m-input"
              type="password"
              value={form.newPassword}
              autoComplete="new-password"
              onChange={(event) =>
                setForm((prev) => ({ ...prev, newPassword: event.target.value }))
              }
            />
          </label>
          <button
            type="button"
            className="m-login-link"
            onClick={() => {
              setUseResetCode((value) => !value)
              setForm((prev) => ({ ...prev, oldPassword: '', resetCode: '' }))
            }}
          >
            {useResetCode ? '改回用原密码修改' : '忘记原密码？用重置口令修改'}
          </button>
        </div>
        <div className="m-sheet-actions">
          <button
            type="button"
            className="m-btn m-btn-primary"
            disabled={saving}
            onClick={() => void savePassword()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
          <button type="button" className="m-btn m-btn-ghost" onClick={() => setPasswordOpen(false)}>
            取消
          </button>
        </div>
      </MobileSheet>

      <MobileModal
        open={logoutOpen}
        title="退出登录？"
        message="退出后需要重新输入账号密码。"
        confirmLabel="退出"
        danger
        onConfirm={() => {
          clearSession()
          navigate('/login', { replace: true })
        }}
        onClose={() => setLogoutOpen(false)}
      />

      <MobileToastHost items={[toast]} />
    </div>
  )
}
