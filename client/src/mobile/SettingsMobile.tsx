import { useState } from 'react'
import { getStoredUsername } from '../api'
import { useRole } from '../hooks/useRole'
import { ROLE_LABELS } from '../permissions'
import { APP_BUILD_TEXT, APP_VERSION_TEXT } from '../version'
import {
  MobileAvatar,
  MobileCard,
  MobileList,
  MobileListItem,
} from './components'
import { useMobileNavigate } from './useMobileNavigate'

type NotifyState = {
  arrival: boolean
  shortage: boolean
  error: boolean
}

const NOTIFY_KEY = 'wood-erp-mobile-notify'

const readNotify = (): NotifyState => {
  try {
    const parsed = JSON.parse(localStorage.getItem(NOTIFY_KEY) ?? '{}') as Partial<NotifyState>
    return {
      arrival: parsed.arrival !== false,
      shortage: parsed.shortage !== false,
      error: parsed.error === true,
    }
  } catch {
    return { arrival: true, shortage: true, error: false }
  }
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <label className="m-settings-row">
      <span>
        <b>{label}</b>
        <small>{hint}</small>
      </span>
      <input
        className="m-switch"
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  )
}

export default function SettingsMobile() {
  const navigate = useMobileNavigate()
  const role = useRole()
  const username = getStoredUsername()
  const [notify, setNotify] = useState(readNotify)

  const updateNotify = (patch: Partial<NotifyState>) => {
    setNotify((prev) => {
      const next = { ...prev, ...patch }
      localStorage.setItem(NOTIFY_KEY, JSON.stringify(next))
      return next
    })
  }

  return (
    <div className="m-stack">
      <MobileCard className="m-profile-card">
        <MobileAvatar name={username} />
        <div className="m-profile-text">
          <b>{username || '—'}</b>
          <span>{ROLE_LABELS[role]} · 当前账号</span>
        </div>
      </MobileCard>

      <MobileCard title="账号信息">
        <div className="m-settings-list">
          <div className="m-settings-row">
            <span>
              <b>用户名</b>
              <small>登录系统使用的账号</small>
            </span>
            <em>{username || '—'}</em>
          </div>
          <div className="m-settings-row">
            <span>
              <b>角色权限</b>
              <small>金额、录单和管理能力由角色决定</small>
            </span>
            <em>{ROLE_LABELS[role]}</em>
          </div>
        </div>
      </MobileCard>

      <MobileCard title="常用项">
        <MobileList>
          <MobileListItem
            title="常用项维护"
            sub="维护录单时可下拉选择的品名和等级"
            onClick={() => navigate('/dict')}
          />
        </MobileList>
      </MobileCard>

      <MobileCard title="通知设置">
        <div className="m-settings-list">
          <ToggleRow
            label="到货提醒"
            hint="有新的采购入库时提示"
            checked={notify.arrival}
            onChange={(value) => updateNotify({ arrival: value })}
          />
          <ToggleRow
            label="库存不足"
            hint="规格库存偏低时提示"
            checked={notify.shortage}
            onChange={(value) => updateNotify({ shortage: value })}
          />
          <ToggleRow
            label="异常提醒"
            hint="同步失败、单据异常时提示"
            checked={notify.error}
            onChange={(value) => updateNotify({ error: value })}
          />
        </div>
        <p className="m-settings-note">通知偏好只保存在本机浏览器，不会上传到服务器。</p>
      </MobileCard>

      <MobileCard title="关于">
        <div className="m-version-box">
          <span>{APP_VERSION_TEXT}</span>
          <span>{APP_BUILD_TEXT}</span>
          <span>数据全部存储在当前部署的服务器中</span>
        </div>
      </MobileCard>
    </div>
  )
}
