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
      <section className="login-visual">
        <div className="login-visual-content">
          <span className="login-badge">木材进销存 · 单机版</span>
          <h1 className="login-brand">立川木业</h1>
          <p className="login-brand-sub">木材进销存管理系统</p>
          <p className="login-desc">
            从原木入库到成品出库，立方、件数与金额按统一公式自动核算；
            规格级库存实时汇总，每笔流水可追溯，数据保存在本机，随时导出 Excel 对账。
          </p>
          <ul className="login-features">
            <li>入库 / 出库 / 库存 / 流水 一体化台账</li>
            <li>立方与金额自动计算，避免手工误差</li>
            <li>出库前按规格校验库存，防止超卖</li>
          </ul>
        </div>
      </section>

      <section className="login-panel">
        <form className="login-card" onSubmit={handleSubmit}>
          <h2 className="login-title">登录</h2>
          <p className="login-hint">请输入管理员账号</p>

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

          {error && <p className="login-error">{error}</p>}

          <button
            className="btn btn-primary login-button"
            type="submit"
            disabled={submitting}
          >
            {submitting ? '登录中…' : '登录'}
          </button>
        </form>

        <p className="login-version">立川木业木材管理系统 · v0.1.0</p>
      </section>
    </div>
  )
}
