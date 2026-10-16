import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { getRememberedUsername, login, setSession } from '../api'
import { resetPassword } from '../api'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { APP_BUILD_TEXT, APP_VERSION_TEXT } from '../version'

export default function Login() {
  const navigate = useNavigate()
  const location = useLocation()
  // 上次勾了「记住账号」的，回来先把账号填上
  const [username, setUsername] = useState(() => getRememberedUsername())
  const [password, setPassword] = useState('')
  /** 「记住账号」：勾上 = 7 天内免登录；不勾 = 关掉浏览器就退（存 sessionStorage） */
  const [remember, setRemember] = useState(true)
  const [showPassword, setShowPassword] = useState(false)
  /** 出错时卡片抖一下：自增这个数触发（连着两次同样的错误也能再抖） */
  const [shakeKey, setShakeKey] = useState(0)
  const [shaking, setShaking] = useState(false)
  const usernameRef = useRef<HTMLInputElement | null>(null)
  // 从别处跳回来时带的提示（比如改完密码要重新登录）——不是报错，用中性色
  const [notice] = useState(
    () => (location.state as { notice?: string } | null)?.notice ?? '',
  )
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [resetForm, setResetForm] = useState({
    resetCode: '',
    newPassword: '',
    confirm: '',
  })
  const [resetError, setResetError] = useState('')
  const [resetDone, setResetDone] = useState(false)
  const [resetting, setResetting] = useState(false)

  useEscapeKey(showHelp, () => setShowHelp(false))

  /*
   * 桌面端进来就把光标放到用户名上（省一次点击）。
   * 手机端**不聚焦**：一聚焦就弹键盘，整个卡片会被顶上去，反而更别扭。
   */
  useEffect(() => {
    if (window.matchMedia('(min-width: 768px)').matches) usernameRef.current?.focus()
  }, [])

  useEffect(() => {
    if (shakeKey === 0) return
    setShaking(true)
    const timer = setTimeout(() => setShaking(false), 460)
    return () => clearTimeout(timer)
  }, [shakeKey])

  const openReset = () => {
    setResetForm({ resetCode: '', newPassword: '', confirm: '' })
    setResetError('')
    setResetDone(false)
    setShowHelp(true)
  }

  const submitReset = async () => {
    if (resetting) return
    if (!resetForm.resetCode.trim()) {
      setResetError('请输入重置口令')
      return
    }
    if (resetForm.newPassword.length < 6) {
      setResetError('新密码至少 6 位')
      return
    }
    if (resetForm.newPassword !== resetForm.confirm) {
      setResetError('两次输入的新密码不一致')
      return
    }

    setResetting(true)
    setResetError('')
    try {
      const result = await resetPassword({
        username: username.trim() || 'admin',
        resetCode: resetForm.resetCode.trim(),
        newPassword: resetForm.newPassword,
      })
      setResetDone(true)
      setUsername(result.username)
      setPassword('')
    } catch (err) {
      setResetError(err instanceof Error ? err.message : '重置失败')
    } finally {
      setResetting(false)
    }
  }

  const handleSubmit = async (event: FormEvent) => {
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
      // 出错了把注意力拉回账号输入框，并抖一下卡片
      setShakeKey((key) => key + 1)
      usernameRef.current?.focus()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login-page">
      <main className="login-panel">
        <form
          className={shaking ? 'login-card is-shaking' : 'login-card'}
          onSubmit={handleSubmit}
        >
          <img className="login-logo" src="/logo.png" alt="立川木业" />
          <h1 className="login-brand">立川木业</h1>
          <p className="login-desc">木材进销存管理系统</p>

          <div className="login-fields">
            <label className="field">
              <span>用户名</span>
              <span className="login-input">
                <svg
                  className="login-input-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="8" r="3.6" />
                  <path d="M5 20c.8-3.4 3.6-5.4 7-5.4s6.2 2 7 5.4" />
                </svg>
                <input
                  ref={usernameRef}
                  className={error ? 'input is-invalid' : 'input'}
                  value={username}
                  autoComplete="username"
                  onChange={(event) => setUsername(event.target.value)}
                />
              </span>
            </label>

            <label className="field">
              <span>密码</span>
              <span className="login-input">
                <svg
                  className="login-input-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="4.8" y="10.4" width="14.4" height="9.6" rx="2.6" />
                  <path d="M8.4 10.4V8a3.6 3.6 0 0 1 7.2 0v2.4" />
                </svg>
                <input
                  className={error ? 'input is-invalid' : 'input'}
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  autoComplete="current-password"
                  onChange={(event) => setPassword(event.target.value)}
                />
                <button
                  type="button"
                  className="login-eye"
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  aria-pressed={showPassword}
                  onClick={(event) => {
                    // 别让 label 把这次点击又转给输入框（会立刻抢走焦点）
                    event.preventDefault()
                    setShowPassword((open) => !open)
                  }}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M2.6 12S6 5.9 12 5.9 21.4 12 21.4 12 18 18.1 12 18.1 2.6 12 2.6 12z" />
                    <circle cx="12" cy="12" r="3.1" />
                    {showPassword && <path d="M4.5 19.5 19.5 4.5" />}
                  </svg>
                </button>
              </span>
            </label>
          </div>

          {/* 「记住账号」和「忘记密码？」同一行（苹果那种排法） */}
          <div className="login-options">
            <label className="login-remember">
              <input
                type="checkbox"
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
              />
              <span>记住账号（7 天内免登录）</span>
            </label>
            <button type="button" className="login-forgot" onClick={openReset}>
              忘记密码？
            </button>
          </div>

          {notice && !error && <p className="login-notice">{notice}</p>}
          {error && (
            <p className="login-error">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 3.9 2.7 20h18.6z" />
                <path d="M12 9.6v4.3" />
                <path d="M12 16.7v.1" />
              </svg>
              <span>{error}</span>
            </p>
          )}

          <button
            className="btn btn-primary login-button"
            type="submit"
            disabled={submitting}
          >
            {submitting && <span className="btn-spinner" aria-hidden="true" />}
            {submitting ? '登录中…' : '登录'}
          </button>
        </form>
      </main>

      <p className="login-version">
        {APP_VERSION_TEXT}
        <span className="build-stamp">{APP_BUILD_TEXT}</span>
      </p>

      {showHelp && (
        <div className="overlay" onClick={() => setShowHelp(false)}>
          <div
            className="modal modal-narrow modal-sheet"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <h2 className="modal-title">重置密码</h2>
              <button
                className="btn btn-sm btn-quiet"
                onClick={() => setShowHelp(false)}
              >
                关闭
              </button>
            </div>

            {resetDone ? (
              <>
                <p className="confirm-text">
                  用户 <strong>{username.trim() || 'admin'}</strong> 的密码已重置成功，
                  请用新密码登录。
                </p>
                <div className="confirm-actions">
                  <button
                    className="btn btn-primary"
                    onClick={() => setShowHelp(false)}
                  >
                    去登录
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="confirm-text">
                  输入重置口令和新密码即可重置用户
                  <strong> {username.trim() || 'admin'} </strong>
                  的密码。重置口令请向管理员索要。
                </p>

                <label className="field">
                  <span>重置口令</span>
                  <input
                    className="input"
                    type="password"
                    value={resetForm.resetCode}
                    autoComplete="off"
                    onChange={(event) =>
                      setResetForm((prev) => ({
                        ...prev,
                        resetCode: event.target.value,
                      }))
                    }
                  />
                </label>

                <label className="field" style={{ marginTop: 14 }}>
                  <span>新密码（至少 6 位）</span>
                  <input
                    className="input"
                    type="password"
                    value={resetForm.newPassword}
                    autoComplete="new-password"
                    onChange={(event) =>
                      setResetForm((prev) => ({
                        ...prev,
                        newPassword: event.target.value,
                      }))
                    }
                  />
                </label>

                <label className="field" style={{ marginTop: 14 }}>
                  <span>确认新密码</span>
                  <input
                    className="input"
                    type="password"
                    value={resetForm.confirm}
                    autoComplete="new-password"
                    onChange={(event) =>
                      setResetForm((prev) => ({
                        ...prev,
                        confirm: event.target.value,
                      }))
                    }
                  />
                </label>

                {resetError && <p className="login-error">{resetError}</p>}

                <div className="confirm-actions" style={{ marginTop: 22 }}>
                  <button className="btn" onClick={() => setShowHelp(false)}>
                    取消
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={() => void submitReset()}
                    disabled={resetting}
                  >
                    {resetting ? '重置中…' : '重置密码'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
