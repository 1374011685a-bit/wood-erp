import { useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { login, setSession } from '../api'

export default function Login() {
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

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
          <div className="login-brand-row">
            <span className="login-mark" aria-hidden="true" />
            <h1 className="login-brand">立川木业</h1>
          </div>
          <p className="login-desc">木材进销存管理系统 · 单机版</p>

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
        </form>
      </main>

      <p className="login-version">立川木业木材管理系统 · v0.1.0</p>
    </div>
  )
}
