import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { clearSession, getStoredUsername } from '../api'
import { PageHead } from '../components/Ui'
import { useRole } from '../hooks/useRole'
import { ROLE_LABELS, canVisit } from '../permissions'

/**
 * 「我的」页 —— 手机上从底部 Tab 进来。
 *
 * 上面是当前账号（用户名 + 角色），下面是菜单：
 * 修改密码 / 设置 / 用户管理（仅管理员）/ 退出登录。
 */
export default function Me() {
  const role = useRole()
  const navigate = useNavigate()
  const [username] = useState(() => getStoredUsername())
  const initial = username ? username.slice(0, 1).toUpperCase() : '?'

  const logout = () => {
    clearSession()
    navigate('/login', { replace: true })
  }

  /**
   * 修改密码的弹窗在 Layout 里（PC 顶栏那个账号菜单也是同一个），
   * 这里派个事件让它打开 —— 免得在两个地方各写一份表单。
   */
  const openPassword = () => window.dispatchEvent(new CustomEvent('wood:open-password'))

  return (
    <section>
      <PageHead title="我的" subtitle="账号和设置" />

      <div className="card me-profile">
        <span className="me-avatar" aria-hidden="true">
          {initial}
        </span>
        <span className="me-profile-text">
          <span className="me-name">{username || '—'}</span>
          <span className="me-role">{ROLE_LABELS[role]}</span>
        </span>
      </div>

      <div className="card entry-list">
        <button type="button" className="entry-item" onClick={openPassword}>
          <span className="entry-main">
            <span className="entry-label">修改密码</span>
          </span>
          <span className="entry-arrow" aria-hidden="true">
            ›
          </span>
        </button>
        <button type="button" className="entry-item" onClick={() => navigate('/dict')}>
          <span className="entry-main">
            <span className="entry-label">设置</span>
            <span className="entry-hint">常用项（品名 / 等级 / 品牌…）</span>
          </span>
          <span className="entry-arrow" aria-hidden="true">
            ›
          </span>
        </button>
        {/* 用户管理只有管理员能进（NAV_ALLOW 里配的就是只用 admin） */}
        {canVisit(role, '/users') && (
          <button type="button" className="entry-item" onClick={() => navigate('/users')}>
            <span className="entry-main">
              <span className="entry-label">用户管理</span>
              <span className="entry-hint">开号 / 改角色 / 重置密码</span>
            </span>
            <span className="entry-arrow" aria-hidden="true">
              ›
            </span>
          </button>
        )}
        <button type="button" className="entry-item entry-item-danger" onClick={logout}>
          <span className="entry-main">
            <span className="entry-label">退出登录</span>
          </span>
          <span className="entry-arrow" aria-hidden="true">
            ›
          </span>
        </button>
      </div>
    </section>
  )
}
