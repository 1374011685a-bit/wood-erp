import { useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { login, setSession } from '../api'
import { resetPassword } from '../api'
import { useEscapeKey } from '../hooks/useEscapeKey'

export default function Login() {
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
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
      setSession(result.token, result.username)
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login-page">
      <main className="login-panel">
        <form className="login-card" onSubmit={handleSubmit}>
          <h1 className="login-brand">立川云</h1>
          <p className="login-desc">木材进销存管理系统</p>

          <div className="login-fields">
            <label className="field">
              <span>用户名</span>
              <input
                className="input"
                value={username}
                autoComplete="username"
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>

            <label className="field">
              <span>密码</span>
              <input
                className="input"
                type="password"
                value={password}
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
          </div>

          {error && <p className="login-error">{error}</p>}

          <button
            className="btn btn-primary login-button"
            type="submit"
            disabled={submitting}
          >
            {submitting ? '登录中…' : '登录'}
          </button>

          <button
            type="button"
            className="login-forgot"
            onClick={openReset}
          >
            忘记密码？
          </button>
        </form>
      </main>

      <p className="login-version">立川云木材管理系统 · v0.1.0</p>

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
                  的密码。重置口令由部署时配置（默认 123，可在服务端环境变量
                  RESET_CODE 中修改）。
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
