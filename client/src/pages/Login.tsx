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
  const [showHelp, setShowHelp] = useState(false)

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
          <h1 className="login-brand">立川木业</h1>
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

          <button
            type="button"
            className="login-forgot"
            onClick={() => setShowHelp(true)}
          >
            忘记密码？
          </button>
        </form>
      </main>

      <p className="login-version">立川木业木材管理系统 · v0.1.0</p>

      {showHelp && (
        <div className="overlay" onClick={() => setShowHelp(false)}>
          <div
            className="modal modal-narrow"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <h2 className="modal-title">忘记密码怎么办</h2>
              <button className="btn" onClick={() => setShowHelp(false)}>
                关闭
              </button>
            </div>

            <p className="confirm-text">
              本系统是单机部署，没有接入邮箱或短信服务，所以不支持自助找回。
              请在<strong>部署本系统的机器</strong>上执行下面的命令重置（需要先停止服务）。
            </p>

            <p className="help-label">重置为随机新密码（推荐）</p>
            <pre className="help-code">node server/reset-password.js</pre>

            <p className="help-label">也可以指定用户名和新密码</p>
            <pre className="help-code">node server/reset-password.js admin 你的新密码</pre>

            <p className="help-label">如果跑在 Docker 里</p>
            <pre className="help-code">docker exec -it &lt;容器名&gt; node server/reset-password.js</pre>

            <p className="hint" style={{ marginTop: 16 }}>
              注意：数据库是「读进内存 + 写回文件」的模式，重置必须在服务停止的状态下执行，
              否则会被运行中的服务覆盖回去。
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
