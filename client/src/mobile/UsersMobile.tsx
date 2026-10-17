import { useCallback, useEffect, useState } from 'react'
import {
  createUser,
  fetchUsers,
  getStoredUsername,
  resetUserPassword,
  updateUser,
  type UserRow,
} from '../api'
import type { Role } from '../permissions'
import { ROLE_LABELS, ROLES } from '../permissions'
import { tapHeavy, tapLight, tapMedium } from '../utils/haptics'
import {
  MobileBadge,
  MobileCard,
  MobileEmpty,
  MobileInput,
  MobileList,
  MobileListItem,
  MobileModal,
  MobileSelect,
  MobileSheet,
  MobileSkeleton,
  MobileToastHost,
  MobileTopbarActions,
  MobileTopbarButton,
  useAutoDismiss,
  type MobileToastItem,
} from './components'

export default function UsersMobile() {
  const me = getStoredUsername()
  const [rows, setRows] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [detail, setDetail] = useState<UserRow | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [resetTarget, setResetTarget] = useState<UserRow | null>(null)
  const [toggleTarget, setToggleTarget] = useState<UserRow | null>(null)
  const [form, setForm] = useState({ username: '', password: '', role: 'viewer' as Role })
  const [newPassword, setNewPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<MobileToastItem | null>(null)
  useAutoDismiss(toast, () => setToast(null))

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setRows((await fetchUsers()).rows)
    } catch (err) {
      setToast({
        id: `l-${Date.now()}`,
        message: err instanceof Error ? err.message : '读取用户失败',
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const patch = async (user: UserRow, payload: { role?: Role; active?: boolean }) => {
    setBusyId(user.id)
    try {
      const updated = await updateUser(user.id, payload)
      setRows((prev) => prev.map((row) => (row.id === updated.id ? updated : row)))
      setDetail((prev) => (prev?.id === updated.id ? updated : prev))
      setToast({
        id: `p-${Date.now()}`,
        message:
          payload.role !== undefined
            ? `${updated.username} 的角色已改为 ${ROLE_LABELS[updated.role]}`
            : updated.active
              ? `${updated.username} 已启用`
              : `${updated.username} 已停用`,
      })
      setToggleTarget(null)
    } catch (err) {
      setToast({
        id: `p-${Date.now()}`,
        message: err instanceof Error ? err.message : '修改失败',
      })
    } finally {
      setBusyId(null)
    }
  }

  const submitCreate = async () => {
    if (!form.username.trim()) {
      setToast({ id: `v-${Date.now()}`, message: '用户名不能为空' })
      return
    }
    if (form.password.length < 6) {
      setToast({ id: `v-${Date.now()}`, message: '初始密码至少 6 位' })
      return
    }
    setSaving(true)
    try {
      const created = await createUser({
        username: form.username.trim(),
        password: form.password,
        role: form.role,
      })
      setRows((prev) => [...prev, created])
      setCreateOpen(false)
      setForm({ username: '', password: '', role: 'viewer' })
      setToast({
        id: `c-${Date.now()}`,
        message: `已创建用户 ${created.username}`,
      })
    } catch (err) {
      setToast({
        id: `c-${Date.now()}`,
        message: err instanceof Error ? err.message : '创建失败',
      })
    } finally {
      setSaving(false)
    }
  }

  const submitReset = async () => {
    if (!resetTarget) return
    if (newPassword.length < 6) {
      setToast({ id: `v-${Date.now()}`, message: '新密码至少 6 位' })
      return
    }
    setSaving(true)
    try {
      await resetUserPassword(resetTarget.id, newPassword)
      setToast({
        id: `r-${Date.now()}`,
        message: `${resetTarget.username} 的密码已重置`,
      })
      setResetTarget(null)
      setNewPassword('')
    } catch (err) {
      setToast({
        id: `r-${Date.now()}`,
        message: err instanceof Error ? err.message : '重置失败',
      })
    } finally {
      setSaving(false)
    }
  }

  const roleOptions = ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] }))

  return (
    <div className="m-stack">
      <MobileTopbarActions>
        <MobileTopbarButton
          label="＋"
          onClick={() => {
            tapLight()
            setForm({ username: '', password: '', role: 'viewer' })
            setCreateOpen(true)
          }}
        />
      </MobileTopbarActions>

      {loading ? (
        <MobileSkeleton cards={3} />
      ) : rows.length === 0 ? (
        <MobileEmpty
          text="还没有用户"
          actionLabel="新增用户"
          onAction={() => setCreateOpen(true)}
        />
      ) : (
        <MobileList>
          {rows.map((user) => (
            <MobileListItem
              key={user.id}
              dense
              title={user.username}
              sub={`${ROLE_LABELS[user.role]} · ${user.created_at}`}
              trail={
                <MobileBadge tone={user.active ? 'ok' : 'danger'}>
                  {user.active ? '在用' : '已停用'}
                </MobileBadge>
              }
              onClick={() => {
                tapLight()
                setDetail(user)
              }}
            />
          ))}
        </MobileList>
      )}

      <MobileSheet
        open={Boolean(detail)}
        title={detail?.username ?? '用户'}
        onClose={() => setDetail(null)}
      >
        {detail ? (
          <>
            <div className="m-rows">
              <div className="m-row">
                <span className="m-row-label">用户名</span>
                <span className="m-row-value">{detail.username}</span>
              </div>
              <div className="m-row">
                <span className="m-row-label">状态</span>
                <span className="m-row-value">{detail.active ? '在用' : '已停用'}</span>
              </div>
              <div className="m-row">
                <span className="m-row-label">创建时间</span>
                <span className="m-row-value">{detail.created_at}</span>
              </div>
            </div>
            <div className="m-user-role">
              <MobileSelect
                label="角色"
                value={detail.role}
                options={roleOptions}
                onChange={(next) => void patch(detail, { role: next as Role })}
              />
              {detail.username === me ? (
                <p className="m-settings-note">不能修改自己的角色或停用自己的账号。</p>
              ) : null}
            </div>
            <div className="m-sheet-actions">
              <button
                type="button"
                className="m-btn m-btn-ghost"
                onClick={() => {
                  setNewPassword('')
                  setResetTarget(detail)
                }}
              >
                重置密码
              </button>
              <button
                type="button"
                className={detail.active ? 'm-btn m-btn-danger' : 'm-btn m-btn-ghost'}
                disabled={detail.username === me || busyId === detail.id}
                onClick={() => {
                  tapHeavy()
                  setToggleTarget(detail)
                }}
              >
                {detail.active ? '停用账号' : '启用账号'}
              </button>
            </div>
          </>
        ) : null}
      </MobileSheet>

      <MobileSheet open={createOpen} title="新增用户" onClose={() => setCreateOpen(false)}>
        <MobileCard title="账号信息">
          <MobileInput
            label="用户名"
            value={form.username}
            onChange={(value) => setForm((prev) => ({ ...prev, username: value }))}
          />
          <label className="m-field">
            <span className="m-field-label">初始密码（至少 6 位）</span>
            <input
              className="m-input"
              type="password"
              value={form.password}
              autoComplete="off"
              onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
            />
          </label>
          <MobileSelect
            label="角色"
            value={form.role}
            options={roleOptions}
            onChange={(next) => setForm((prev) => ({ ...prev, role: next as Role }))}
          />
        </MobileCard>
        <div className="m-sheet-actions">
          <button
            type="button"
            className="m-btn m-btn-primary"
            disabled={saving}
            onClick={() => {
              tapMedium()
              void submitCreate()
            }}
          >
            {saving ? '创建中…' : '创建用户'}
          </button>
          <button type="button" className="m-btn m-btn-ghost" onClick={() => setCreateOpen(false)}>
            取消
          </button>
        </div>
      </MobileSheet>

      <MobileSheet
        open={Boolean(resetTarget)}
        title="重置密码"
        onClose={() => setResetTarget(null)}
      >
        {resetTarget ? (
          <>
            <p className="m-sheet-help">
              把 {resetTarget.username} 的密码改成新密码。对方当前登录会立即失效。
            </p>
            <label className="m-field">
              <span className="m-field-label">新密码（至少 6 位）</span>
              <input
                className="m-input"
                type="password"
                value={newPassword}
                autoComplete="off"
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </label>
            <div className="m-sheet-actions">
              <button
                type="button"
                className="m-btn m-btn-primary"
                disabled={saving}
                onClick={() => void submitReset()}
              >
                {saving ? '重置中…' : '确认重置'}
              </button>
              <button type="button" className="m-btn m-btn-ghost" onClick={() => setResetTarget(null)}>
                取消
              </button>
            </div>
          </>
        ) : null}
      </MobileSheet>

      <MobileModal
        open={Boolean(toggleTarget)}
        title={toggleTarget?.active ? '停用这个账号？' : '启用这个账号？'}
        message={
          toggleTarget
            ? toggleTarget.active
              ? `${toggleTarget.username} 将无法继续登录，资料和历史单据不受影响。`
              : `${toggleTarget.username} 将恢复登录能力。`
            : undefined
        }
        confirmLabel="确认"
        danger={Boolean(toggleTarget?.active)}
        onConfirm={() => {
          if (toggleTarget) {
            void patch(toggleTarget, { active: !toggleTarget.active })
          }
        }}
        onClose={() => setToggleTarget(null)}
      />

      <MobileToastHost items={[toast]} />
    </div>
  )
}
