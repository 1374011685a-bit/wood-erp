import { useCallback, useEffect, useState } from 'react'
import {
  createUser,
  getStoredUsername,
  fetchUsers,
  resetUserPassword,
  updateUser,
  type UserRow,
} from '../api'
import { ROLE_LABELS, ROLES } from '../permissions'
import type { Role } from '../permissions'
import { PageHead, ToastHost, type ToastItem } from '../components/Ui'

/**
 * 用户管理（只有管理员能进 —— 路由和菜单都按 NAV_ALLOW 挡过，后端还有 requireCap）。
 *
 * 三条后端硬约束会在界面上以中文报错返回，这里原样展示：
 *   最后一个管理员不能降级/停用；不能改自己；用户名不能重复。
 */

type DeleteTarget = { kind: 'reset'; user: UserRow } | null

export default function Users() {
  const [rows, setRows] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [toast, setToast] = useState<ToastItem | null>(null)
  /** 自己这一行不给改角色也不给停用（后端也拦，但按钮直接置灰更好懂） */
  const me = getStoredUsername()

  // 开号表单
  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState({ username: '', password: '', role: 'viewer' as Role })
  const [creating, setCreating] = useState(false)

  // 重置密码
  const [resetTarget, setResetTarget] = useState<DeleteTarget>(null)
  const [newPassword, setNewPassword] = useState('')
  const [resetting, setResetting] = useState(false)

  const notify = (kind: ToastItem['kind'], message: string) =>
    setToast({ id: `${Date.now()}`, kind, message, onClose: () => setToast(null) })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await fetchUsers()
      setRows(result.rows)
    } catch (err) {
      notify('error', err instanceof Error ? err.message : '读取用户失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** 改角色 / 停用启用：改一个人就整表刷新，免得本地状态和服务端对不上 */
  const patch = async (user: UserRow, payload: { role?: Role; active?: boolean }) => {
    setBusyId(user.id)
    try {
      const updated = await updateUser(user.id, payload)
      setRows((prev) => prev.map((row) => (row.id === updated.id ? updated : row)))
      const what =
        payload.role !== undefined
          ? `角色已改成「${ROLE_LABELS[updated.role]}」`
          : payload.active
            ? '账号已启用'
            : '账号已停用'
      notify('success', `${updated.username}：${what}`)
    } catch (err) {
      notify('error', err instanceof Error ? err.message : '修改失败')
    } finally {
      setBusyId(null)
    }
  }

  const submitCreate = async () => {
    if (creating) return
    setCreating(true)
    try {
      const created = await createUser({
        username: form.username.trim(),
        password: form.password,
        role: form.role,
      })
      setRows((prev) => [...prev, created])
      setCreateOpen(false)
      setForm({ username: '', password: '', role: 'viewer' })
      notify('success', `已创建用户 ${created.username}（${ROLE_LABELS[created.role]}）`)
    } catch (err) {
      notify('error', err instanceof Error ? err.message : '创建失败')
    } finally {
      setCreating(false)
    }
  }

  const submitReset = async () => {
    if (!resetTarget || resetting) return
    setResetting(true)
    try {
      await resetUserPassword(resetTarget.user.id, newPassword)
      const name = resetTarget.user.username
      setResetTarget(null)
      setNewPassword('')
      notify('success', `${name} 的密码已重置，对方需要重新登录`)
    } catch (err) {
      notify('error', err instanceof Error ? err.message : '重置失败')
    } finally {
      setResetting(false)
    }
  }

  return (
    <>
      <PageHead
        title="用户管理"
        subtitle="开号、改角色、停用账号、重置密码。金额对「业务员 / 仓管 / 只读」一律不显示"
        extra={
          <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
            新增用户
          </button>
        }
      />

      <ToastHost items={[toast]} />

      <div className="card">
        {loading ? (
          <p className="muted">加载中…</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>用户名</th>
                <th>角色</th>
                <th>状态</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((user) => (
                <tr key={user.id}>
                  <td>{user.username}</td>
                  <td>
                    <select
                      className="input"
                      style={{ height: 34, minWidth: 120 }}
                      value={user.role}
                      disabled={busyId === user.id || user.username === me}
                      title={user.username === me ? '不能改自己的角色' : undefined}
                      onChange={(event) =>
                        void patch(user, { role: event.target.value as Role })
                      }
                    >
                      {ROLES.map((role) => (
                        <option key={role} value={role}>
                          {ROLE_LABELS[role]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {user.active ? (
                      <span className="tag tag-in">在用</span>
                    ) : (
                      <span className="tag tag-out">已停用</span>
                    )}
                  </td>
                  <td className="muted">{user.created_at}</td>
                  <td>
                    <div className="row-actions">
                      <button
                        className="btn btn-sm"
                        onClick={() => {
                          setNewPassword('')
                          setResetTarget({ kind: 'reset', user })
                        }}
                      >
                        重置密码
                      </button>
                      <button
                        className={user.active ? 'btn btn-sm btn-danger' : 'btn btn-sm'}
                        disabled={busyId === user.id || user.username === me}
                        title={user.username === me ? '不能停用自己的账号' : undefined}
                        onClick={() => void patch(user, { active: !user.active })}
                      >
                        {user.active ? '停用' : '启用'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {createOpen && (
        <div className="overlay" onClick={() => setCreateOpen(false)}>
          <div className="modal modal-narrow modal-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2 className="modal-title">新增用户</h2>
              <button className="btn btn-sm btn-quiet" onClick={() => setCreateOpen(false)}>
                关闭
              </button>
            </div>

            <label className="field">
              <span>用户名</span>
              <input
                className="input"
                value={form.username}
                autoComplete="off"
                onChange={(e) => setForm((prev) => ({ ...prev, username: e.target.value }))}
              />
            </label>

            <label className="field" style={{ marginTop: 14 }}>
              <span>初始密码（至少 6 位）</span>
              <input
                className="input"
                type="text"
                value={form.password}
                autoComplete="off"
                onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
              />
            </label>

            <label className="field" style={{ marginTop: 14 }}>
              <span>角色</span>
              <select
                className="input"
                value={form.role}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, role: e.target.value as Role }))
                }
              >
                {ROLES.map((role) => (
                  <option key={role} value={role}>
                    {ROLE_LABELS[role]}
                  </option>
                ))}
              </select>
            </label>

            <p className="hint" style={{ marginTop: 14 }}>
              业务员、仓管、只读这三种角色看不到任何金额字段（后端直接不返回）。
            </p>

            <div className="confirm-actions" style={{ marginTop: 22 }}>
              <button className="btn" onClick={() => setCreateOpen(false)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                disabled={creating}
                onClick={() => void submitCreate()}
              >
                {creating ? '创建中…' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {resetTarget && (
        <div className="overlay" onClick={() => setResetTarget(null)}>
          <div
            className="modal modal-narrow modal-alert"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="modal-title">重置密码</h2>
            <p className="confirm-text">
              把 <strong>{resetTarget.user.username}</strong> 的密码改成新密码。
              对方当前的登录状态会立刻失效，需要用新密码重新登录。
            </p>

            <label className="field" style={{ textAlign: 'left' }}>
              <span>新密码（至少 6 位）</span>
              <input
                className="input"
                type="text"
                value={newPassword}
                autoComplete="off"
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </label>

            <div className="confirm-actions" style={{ marginTop: 20 }}>
              <button className="btn" onClick={() => setResetTarget(null)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                disabled={resetting}
                onClick={() => void submitReset()}
              >
                {resetting ? '重置中…' : '确认重置'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
