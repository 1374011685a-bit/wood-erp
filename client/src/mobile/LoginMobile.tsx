import { useEffect, useState, type FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  getRememberedUsername,
  login,
  resetPassword,
  setSession,
} from '../api'
import { APP_BUILD_TEXT, APP_VERSION_TEXT } from '../version'
import {
  MobileSheet,
  MobileToastHost,
  useAutoDismiss,
  type MobileToastItem,
} from './components'

export default function LoginMobile() {
  const navigate = useNavigate()
  const location = useLocation()
  const [username, setUsername] = useState(() => getRememberedUsername())
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [shakeKey, setShakeKey] = useState(0)
  const [shaking, setShaking] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [resetForm, setResetForm] = useState({ resetCode: '', newPassword: '', confirm: '' })
  const [resetting, setResetting] = useState(false)
  const [resetDone, setResetDone] = useState(false)
  const [toast, setToast] = useState<MobileToastItem | null>(null)
  useAutoDismiss(toast, () => setToast(null))

  const notice = (location.state as { notice?: string } | null)?.notice ?? ''

  useEffect(() => {
    if (shakeKey === 0) return
    setShaking(true)
    const timer = window.setTimeout(() => setShaking(false), 460)
    return () => window.clearTimeout(timer)
  }, [shakeKey])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError('')
    try {
      const result = await login(username.trim(), password)
      setSession(result.token, result.username, result.role, remember)
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
      setShakeKey((value) => value + 1)
    } finally {
      setSubmitting(false)
    }
  }

  const submitReset = async () => {
    if (resetting) return
    if (!resetForm.resetCode.trim()) {
      setToast({ id: `r-${Date.now()}`, message: '请输入重置口令' })
      return
    }
    if (resetForm.newPassword.length < 6) {
      setToast({ id: `r-${Date.now()}`, message: '新密码至少 6 位' })
      return
    }
    if (resetForm.newPassword !== resetForm.confirm) {
      setToast({ id: `r-${Date.now()}`, message: '两次输入的新密码不一致' })
      return
    }
    setResetting(true)
    try {
      const result = await resetPassword({
        username: username.trim() || 'admin',
        resetCode: resetForm.resetCode.trim(),
        newPassword: resetForm.newPassword,
      })
      setUsername(result.username)
      setPassword('')
      setResetDone(true)
    } catch (err) {
      setToast({
        id: `r-${Date.now()}`,
        message: err instanceof Error ? err.message : '重置失败',
      })
    } finally {
      setResetting(false)
    }
  }

  return (
    <div className="m-login-page">
      <main className="m-login-main">
        <div className="m-login-brand">
          <img src="/logo.png" alt="立川木业" />
          <h1>立川木业</h1>
          <p>木材进销存管理系统</p>
        </div>

        <form
          className={shaking ? 'm-login-card is-shaking' : 'm-login-card'}
          onSubmit={(event) => void submit(event)}
        >
          {notice && !error ? <p className="m-login-notice">{notice}</p> : null}
          {error ? <p className="m-login-error">{error}</p> : null}

          <label className="m-field">
            <span className="m-field-label">用户名</span>
            <input
              className="m-input"
              value={username}
              autoComplete="username"
              autoCapitalize="none"
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>

          <label className="m-field">
            <span className="m-field-label">密码</span>
            <span className="m-login-password">
              <input
                className="m-input"
                type={showPassword ? 'text' : 'password'}
                value={password}
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                type="button"
                onClick={() => setShowPassword((open) => !open)}
              >
                {showPassword ? '隐藏' : '显示'}
              </button>
            </span>
          </label>

          <div className="m-login-options">
            <label className="m-login-check">
              <input
                type="checkbox"
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
              />
              <span>记住账号</span>
            </label>
            <button
              type="button"
              className="m-login-link"
              onClick={() => {
                setResetDone(false)
                setResetForm({ resetCode: '', newPassword: '', confirm: '' })
                setHelpOpen(true)
              }}
            >
              忘记密码？
            </button>
          </div>

          <button type="submit" className="m-btn m-btn-primary m-login-submit" disabled={submitting}>
            {submitting ? '登录中…' : '登录'}
          </button>
        </form>
      </main>

      <p className="m-login-version">
        {APP_VERSION_TEXT}
        <span>{APP_BUILD_TEXT}</span>
      </p>

      <MobileSheet
        open={helpOpen}
        title="重置密码"
        onClose={() => setHelpOpen(false)}
      >
        {resetDone ? (
          <div className="m-reset-done">
            <p>密码已重置，请用新密码登录。</p>
            <button type="button" className="m-btn m-btn-primary" onClick={() => setHelpOpen(false)}>
              去登录
            </button>
          </div>
        ) : (
          <>
            <p className="m-sheet-help">
              重置口令请向管理员索要。当前账号：{username.trim() || 'admin'}
            </p>
            <div className="m-stack-tight">
              <label className="m-field">
                <span className="m-field-label">重置口令</span>
                <input
                  className="m-input"
                  type="password"
                  value={resetForm.resetCode}
                  autoComplete="off"
                  onChange={(event) =>
                    setResetForm((prev) => ({ ...prev, resetCode: event.target.value }))
                  }
                />
              </label>
              <label className="m-field">
                <span className="m-field-label">新密码（至少 6 位）</span>
                <input
                  className="m-input"
                  type="password"
                  value={resetForm.newPassword}
                  autoComplete="new-password"
                  onChange={(event) =>
                    setResetForm((prev) => ({ ...prev, newPassword: event.target.value }))
                  }
                />
              </label>
              <label className="m-field">
                <span className="m-field-label">确认新密码</span>
                <input
                  className="m-input"
                  type="password"
                  value={resetForm.confirm}
                  autoComplete="new-password"
                  onChange={(event) =>
                    setResetForm((prev) => ({ ...prev, confirm: event.target.value }))
                  }
                />
              </label>
            </div>
            <div className="m-sheet-actions">
              <button
                type="button"
                className="m-btn m-btn-primary"
                disabled={resetting}
                onClick={() => void submitReset()}
              >
                {resetting ? '提交中…' : '重置密码'}
              </button>
              <button type="button" className="m-btn m-btn-ghost" onClick={() => setHelpOpen(false)}>
                取消
              </button>
            </div>
          </>
        )}
      </MobileSheet>

      <MobileToastHost items={[toast]} />
    </div>
  )
}
