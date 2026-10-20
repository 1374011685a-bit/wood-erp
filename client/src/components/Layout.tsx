import { Suspense, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  changePassword,
  clearSession,
  getStoredUsername,
  resetPassword,
} from '../api'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { useRole } from '../hooks/useRole'
import { canVisit } from '../permissions'
import { useOnline } from '../hooks/useOnline'
import { applyTableLabels } from '../utils/tableLabels'
import BottomNav from './BottomNav'
import { PageContainer } from './PageScaffold'
import { RouteProgress, ToastHost, type ToastItem } from './Ui'

type NavItem = {
  to: string
  label: string
  end?: boolean
  icon: ReactNode
}

/** 首页独立放最上面，不归到任何分类里 */
const homeItem: NavItem = {
  to: '/',
  label: '首页',
  end: true,
  icon: <path d="M3 10.6 12 3l9 7.6V20a1 1 0 0 1-1 1h-5.5v-6h-5v6H4a1 1 0 0 1-1-1z" />,
}

type NavGroup = {
  key: string
  label: string
  hint: string
  items: NavItem[]
}

/** 按业务归类：点分组标题可以展开 / 收起 */
const navGroups: NavGroup[] = [
  {
    key: 'purchase',
    label: '采购',
    hint: '向供应商进货',
    items: [
      {
    to: '/contracts',
    label: '采购合同',
    icon: (
      <>
        <path d="M6.8 3.6h7.4l4.2 4.2v12.6H6.8z" />
        <path d="M13.9 3.6v4.5h4.5" />
        <path d="M9.6 13.4h5M9.6 16.4h5" />
      </>
    ),
      },
      {
    to: '/inbound',
    label: '采购入库',
    icon: (
      <>
        <path d="M12 3v10" />
        <path d="m8 9 4 4 4-4" />
        <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
      </>
    ),
      },
      {
    to: '/bales',
    label: '采购入库明细',
    icon: (
      <>
        <rect x="3.5" y="6" width="17" height="12" rx="2.2" />
        <path d="M7.5 10h5M7.5 13.5h9" />
        <path d="M16.5 9.5h1.2v5h-1.2z" />
      </>
    ),
      },
    ],
  },
  {
    key: 'sale',
    label: '销售',
    hint: '发货给客户',
    items: [
      {
    to: '/outbound',
    label: '出库',
    icon: (
      <>
        <path d="M12 13V3" />
        <path d="m8 7 4-4 4 4" />
        <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
      </>
    ),
      },
    ],
  },
  {
    key: 'stock',
    label: '仓库',
    hint: '库存与盘点',
    items: [
      {
    to: '/stock',
    label: '库存',
    icon: (
      <>
        <path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z" />
        <path d="M3 7.5 12 12l9-4.5" />
        <path d="M12 12v9" />
      </>
    ),
      },
      {
    to: '/count',
    label: '盘点',
    icon: (
      <>
        <path d="M9 4.5h6a1 1 0 0 1 1 1v1H8v-1a1 1 0 0 1 1-1z" />
        <path d="M6.5 6.5h11v12a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2z" />
        <path d="m9.6 13.4 1.7 1.7 3.4-3.6" />
      </>
    ),
      },
      {
        to: '/repack',
        label: '改包',
        icon: (
          <>
            <path d="M4 8.5 12 4.5l8 4v7l-8 4-8-4z" />
            <path d="m9.2 12.6 2 2 4-4.4" />
          </>
        ),
      },
      {
    to: '/records',
    label: '流水',
    icon: (
      <>
        <path d="M8 6h13M8 12h13M8 18h13" />
        <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
      </>
    ),
      },
    ],
  },
  {
    key: 'finance',
    label: '财务',
    hint: '应收应付与对账',
    items: [
      {
    to: '/settlement',
    label: '对账',
    icon: (
      <>
        <path d="M6.8 3.6h6.9l4.5 4.5v12.3H6.8z" />
        <path d="M13.4 3.6v4.8h4.8" />
        <path d="m9.9 12.3 2.1 2.4 2.1-2.4" />
        <path d="M12 14.7v4" />
        <path d="M9.9 15.9h4.2M9.9 17.3h4.2" />
      </>
    ),
      },
    ],
  },
  {
    key: 'system',
    label: '系统',
    hint: '常用项与已删除的单据',
    items: [
      {
        to: '/dict',
        label: '常用项',
        icon: (
          <>
            <path d="M4.5 6.5h9M4.5 12h6" />
            <path d="M17.4 4.8v6.4" />
            <path d="M14.2 8h6.4" />
            <path d="M4.5 17.5h15" />
          </>
        ),
      },
      {
    to: '/recycle',
    label: '回收站',
    icon: (
      <>
        <path d="M4 6.5h16" />
        <path d="M9.5 6.5V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5" />
        <path d="M6.5 6.5 7.4 19a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5l.9-12.5" />
        <path d="M10.2 10.5v6M13.8 10.5v6" />
      </>
    ),
      },
      {
        to: '/users',
        label: '用户管理',
        icon: (
          <>
            <circle cx="9.5" cy="8.5" r="3.2" />
            <path d="M3.8 19.5c0-3.1 2.6-5.2 5.7-5.2s5.7 2.1 5.7 5.2" />
            <path d="M16.2 6.4h4.2M18.3 4.3v4.2" />
          </>
        ),
      },
      {
        to: '/ai',
        label: 'AI 助手',
        icon: (
          <>
            <path d="M12 3.6l1.9 4.9 4.9 1.9-4.9 1.9L12 17.2l-1.9-4.9L5.2 10.4l4.9-1.9z" />
            <path d="M18.4 16.2l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
          </>
        ),
      },
    ],
  },
]

const navItems: NavItem[] = [homeItem, ...navGroups.flatMap((group) => group.items)]

/** 不在左侧菜单里、但顶栏标题 / 功能标签要用到的页面名 */
const EXTRA_LABELS: Record<string, string> = {
  '/documents': '单据',
  '/me': '我的',
}

const ROLE_LABELS: Record<string, string> = {
  admin: '管理员',
  finance: '财务',
  sales: '业务员',
  warehouse: '仓管',
  viewer: '只读',
}

/** 路由 → 标签名（和左侧菜单同名） */
function labelOf(path: string) {
  // /inbound/new、/outbound/new 这类「直接进录入」的地址，标签跟它所属的功能同名
  const base = path.replace(/\/new$/, '')
  const hit = navItems.find((item) => item.to === base)
  if (hit) return hit.label
  if (EXTRA_LABELS[base]) return EXTRA_LABELS[base]
  return base.replace(/^\//, '') || '首页'
}

export default function Layout() {
  const navigate = useNavigate()
  const location = useLocation()
  const role = useRole()
  /**
   * 菜单按角色过滤：没权限的分组和菜单项直接不渲染。
   * 空分组（比如只读角色看不到「财务」「系统」里的任何一项）整组去掉，
   * 免得留一个点开是空的分组标题。
   */
  const visibleGroups = navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => canVisit(role, item.to)),
    }))
    .filter((group) => group.items.length > 0)
  // 打开的功能标签（点一个功能就像开一个网页，可以来回切、可以关）
  const [tabs, setTabs] = useState<{ path: string; label: string }[]>(() => [
    location.pathname === '/'
      ? null
      : { path: location.pathname, label: labelOf(location.pathname) },
  ].filter(Boolean) as { path: string; label: string }[])
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; path: string } | null>(null)
  const [globalSearch, setGlobalSearch] = useState('')
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false)
  // RequireAuth 校验通过后会把用户名写进 localStorage，这里读一次即可
  const [username] = useState(() => getStoredUsername())
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [useResetCode, setUseResetCode] = useState(false)
  const [resetCode, setResetCode] = useState('')
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<ToastItem | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  // 手机端的抽屉式侧边栏
  const [drawerOpen, setDrawerOpen] = useState(false)
  const accountRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLDivElement | null>(null)
  const tabMenuRef = useRef<HTMLDivElement | null>(null)
  // 分组默认全展开，点标题可以收起；切到某个功能时会自动把它所在的分组展开
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(navGroups.map((group) => [group.key, true])),
  )

  // 点击空白处收起账号菜单（苹果的菜单行为）
  useEffect(() => {
    if (!menuOpen) return

    const handlePointerDown = (event: MouseEvent) => {
      if (!accountRef.current?.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [menuOpen])

  useEffect(() => {
    if (!globalSearchOpen && !tabMenu) return

    const handlePointerDown = (event: MouseEvent) => {
      if (!searchRef.current?.contains(event.target as Node)) {
        setGlobalSearchOpen(false)
      }
      if (!tabMenuRef.current?.contains(event.target as Node)) {
        setTabMenu(null)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [globalSearchOpen, tabMenu])

  useEscapeKey(menuOpen, () => setMenuOpen(false))
  useEscapeKey(globalSearchOpen, () => setGlobalSearchOpen(false))
  useEscapeKey(Boolean(tabMenu), () => setTabMenu(null))

  /*
   * 底部 sheet 的「按住把手往下拖 = 关闭」。
   *
   * 放在外壳里统一做：筛选 sheet / 账号菜单 / 危险弹窗各写一遍太啰嗦。
   * 只认 sheet 顶部那 30px 的把手区（往下拖才生效），拖过 60px 松手才关；
   * 关闭动作复用各页面**现成的关闭入口**（遮罩 / 关闭按钮 / 点空白），
   * 所以加这个功能一个页面都不用改。
   */
  useEffect(() => {
    const HANDLE_ZONE = 30
    const CLOSE_AT = 60
    let sheet: HTMLElement | null = null
    let startY = 0
    let moved = 0

    const onStart = (event: TouchEvent) => {
      const el = (event.target as HTMLElement | null)?.closest<HTMLElement>(
        '.modal-alert, .filter-sheet.is-open, .account-menu',
      )
      if (!el) return
      const y = event.touches[0]?.clientY ?? 0
      // 只有"把手那一带"算拖拽区，免得在表单里往下滑就把它关了
      if (y - el.getBoundingClientRect().top > HANDLE_ZONE) return
      sheet = el
      startY = y
      moved = 0
      el.style.transition = 'none'
    }

    const onMove = (event: TouchEvent) => {
      if (!sheet) return
      moved = Math.max(0, (event.touches[0]?.clientY ?? 0) - startY)
      sheet.style.transform = moved > 0 ? `translateY(${Math.min(moved, 240)}px)` : ''
      if (event.cancelable && moved > 4) event.preventDefault()
    }

    const onEnd = () => {
      const el = sheet
      sheet = null
      if (!el) return
      el.style.transition = 'transform 0.18s cubic-bezier(0.32, 0.72, 0, 1)'
      if (moved > CLOSE_AT) {
        el.style.transform = 'translateY(110%)'
        window.setTimeout(() => {
          el.style.transform = ''
          const overlay = el.closest('.overlay')
          if (el.classList.contains('filter-sheet')) {
            document.querySelector<HTMLElement>('.filter-sheet-mask')?.click()
          } else if (overlay instanceof HTMLElement) {
            overlay.click()
          } else {
            // 账号菜单：它监听的是 mousedown（点空白处收起）
            document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
          }
        }, 170)
      } else {
        el.style.transform = ''
      }
    }

    window.addEventListener('touchstart', onStart, { passive: true })
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('touchend', onEnd)
    window.addEventListener('touchcancel', onEnd)
    return () => {
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', onEnd)
    }
  }, [])
  useEscapeKey(passwordOpen, () => setPasswordOpen(false))
  useEscapeKey(drawerOpen, () => setDrawerOpen(false))

  // 手机端点完菜单就收起抽屉
  useEffect(() => {
    setDrawerOpen(false)
  }, [location.pathname])

  /**
   * 手机上表格要变成卡片，需要知道每一格对应哪个表头。
   * 这里在内容区挂一个观察器，页面一变就把表头文字同步到格子上——
   * 页面组件不用为手机端写任何额外代码。
   */
  useEffect(() => {
    const target = document.querySelector('.content')
    if (!target) return

    let frame = 0
    const sync = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => applyTableLabels(target))
    }

    sync()
    const observer = new MutationObserver(sync)
    observer.observe(target, { childList: true, subtree: true })

    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [])

  // 切到没打开过的功能就补一个标签（首页不做索引）
  useEffect(() => {
    if (location.pathname === '/') return
    // 没权限的页面不留标签（手敲地址进来的情况）
    if (!canVisit(role, location.pathname)) return
    setTabs((prev) =>
      prev.some((tab) => tab.path === location.pathname)
        ? prev
        : [...prev, { path: location.pathname, label: labelOf(location.pathname) }],
    )
  }, [location.pathname, role])

  /**
   * 路由守卫：当前角色进不了的页面，直接送回首页。
   * 后端也会拦（403），但让页面停在半路、报一堆错更难看。
   */
  useEffect(() => {
    if (canVisit(role, location.pathname)) return
    setToast({
      id: 'no-permission',
      kind: 'error',
      message: '你没有这个功能的权限，请联系管理员',
      onClose: () => setToast(null),
    })
    navigate('/', { replace: true })
  }, [location.pathname, role, navigate])

  // 角色变过之后，之前开着的、现在没权限的标签也要拿掉
  const visibleTabs = tabs.filter((tab) => canVisit(role, tab.path))

  // 当前功能所在的分组要是被收起了，进来时自动展开
  useEffect(() => {
    const group = navGroups.find((item) =>
      item.items.some((entry) => entry.to === location.pathname),
    )
    if (!group) return
    setOpenGroups((prev) => (prev[group.key] ? prev : { ...prev, [group.key]: true }))
  }, [location.pathname])

  // 关标签：关掉当前页就切到左边那个（没有就切到第一个）
  const closeTab = (path: string) => {
    const next = tabs.filter((tab) => tab.path !== path)
    setTabs(next)

    if (path === location.pathname) {
      if (next.length === 0) {
        navigate('/')
        return
      }
      const index = tabs.findIndex((tab) => tab.path === path)
      const target = next[Math.min(Math.max(index - 1, 0), next.length - 1)] ?? next[0]
      navigate(target.path)
    }
  }

  const closeOtherTabs = (path: string) => {
    const keep = tabs.find((tab) => tab.path === path)
    setTabs(keep ? [keep] : [])
    setTabMenu(null)
    if (location.pathname !== path) navigate(path)
  }

  const closeAllTabs = () => {
    setTabs([])
    setTabMenu(null)
    navigate('/')
  }

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen()
    } else {
      void document.documentElement.requestFullscreen()
    }
  }

  const searchMenuItems = navItems
    .filter((item) => canVisit(role, item.to))
    .filter((item) => {
      const keyword = globalSearch.trim().toLowerCase()
      return !keyword || item.label.toLowerCase().includes(keyword) || item.to.includes(keyword)
    })
    .slice(0, 8)

  // 菜单一打开就把焦点交给第一项，键盘可以直接上下选、回车确认
  useEffect(() => {
    if (!menuOpen) return
    menuRef.current?.querySelector<HTMLButtonElement>('.account-menu-item')?.focus()
  }, [menuOpen])

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return

    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('.account-menu-item') ?? [],
    )
    if (items.length === 0) return

    event.preventDefault()
    const step = event.key === 'ArrowDown' ? 1 : -1
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = (current + step + items.length) % items.length
    items[next]?.focus()
  }

  const initial = (username.trim().charAt(0) || 'U').toUpperCase()

  /*
   * 左上角「返回」：只给二级页用 —— 底部 4 个 Tab 那几个页面是"根"，
   * 其它（新增/编辑表单、打印、AI、单据、我的…）都算二级页。
   *
   * 有历史就退历史；直接从深链进来（没有上一页）时退到它的上一层路径，
   * 免得点了没反应。
   */
  const ROOT_PATHS = ['/', '/documents', '/stock', '/me']
  const showBack = !ROOT_PATHS.includes(location.pathname)
  const goBack = async () => {
    if (window.history.length > 1) {
      navigate(-1)
      return
    }
    const parent = `/${location.pathname.split('/').filter(Boolean).slice(0, -1).join('/')}`
    navigate(parent === '/' ? '/' : parent)
  }

  /**
   * 离线灰条：断网（或请求根本发不出去）时顶栏下面挂一条，
   * 恢复网络后淡出。手机上它正好在顶栏（56px）下面，桌面端贴在页面顶部。
   *
   * 最短展示 3 秒：网络层错误往往只影响一个接口，紧跟其后的另一个请求
   * 一旦成功就会把状态判回"在线"，灰条闪一下就没 —— 用户只会觉得莫名。
   * 所以挂上去之后至少停 3 秒；超过 3 秒再恢复网络就立刻淡出，不硬等。
   */
  const OFFLINE_BAR_MIN_MS = 3000
  const OFFLINE_BAR_FADE_MS = 180
  const online = useOnline()
  const [offlineBarVisible, setOfflineBarVisible] = useState(false)
  const [offlineBarFading, setOfflineBarFading] = useState(false)
  /** 这一轮离线是什么时候开始的（决定 3 秒怎么算） */
  const offlineSinceRef = useRef(0)
  /** 灰条当前是不是挂着（ref 版，给 effect 里读，避免进依赖） */
  const offlineBarMountedRef = useRef(false)
  useEffect(() => {
    if (!online) {
      setOfflineBarFading(false) // 淡出途中又断了：取消淡出
      if (offlineBarMountedRef.current) return // 同一轮离线，别重置计时
      offlineBarMountedRef.current = true
      offlineSinceRef.current = Date.now()
      setOfflineBarVisible(true)
      return
    }
    if (!offlineBarMountedRef.current) return
    // 恢复网络：先补足最短展示时长，再淡出（180ms），别"啪"一下消失
    const elapsed = Date.now() - offlineSinceRef.current
    const wait = Math.max(0, OFFLINE_BAR_MIN_MS - elapsed)
    let fadeTimer = 0
    const holdTimer = window.setTimeout(() => {
      setOfflineBarFading(true)
      fadeTimer = window.setTimeout(() => {
        offlineBarMountedRef.current = false
        setOfflineBarVisible(false)
        setOfflineBarFading(false)
      }, OFFLINE_BAR_FADE_MS)
    }, wait)
    return () => {
      window.clearTimeout(holdTimer)
      if (fadeTimer) window.clearTimeout(fadeTimer)
    }
  }, [online])

  /**
   * 滚动位置记忆：切 Tab / 进二级页再回来，回到原来的位置，不从顶部重新开始。
   * 懒加载的页面渲染会晚一拍，所以恢复动作做两次（立刻一次、220ms 后一次）。
   */
  const scrollMemory = useRef(new Map<string, number>())
  const lastPath = useRef(location.pathname)

  /*
   * 滚动位置要**持续记录**，不能等到切页时再读：
   * 切页的那一刹那新页面已经渲染出来了，如果它比原来短，浏览器会把 scrollY 夹回 0，
   * 那时候再读就拿不到"离开时滚到哪"了。所以挂在 scroll 事件上按帧记。
   */
  useEffect(() => {
    let frame = 0
    const onScroll = () => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        scrollMemory.current.set(location.pathname, window.scrollY)
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [location.pathname])

  useEffect(() => {
    const from = lastPath.current
    const to = location.pathname
    if (from === to) return
    lastPath.current = to
    const target = scrollMemory.current.get(to) ?? 0
    const restore = () => window.scrollTo({ top: target })
    const first = window.setTimeout(restore, 0)
    const second = window.setTimeout(restore, 220)
    return () => {
      window.clearTimeout(first)
      window.clearTimeout(second)
    }
  }, [location.pathname])

  const handleLogout = () => {
    clearSession()
    navigate('/login', { replace: true })
  }

  /**
   * 「我的」页（手机端底部 Tab）点「修改密码」时，派发 `wood:open-password` 事件，
   * 由这里打开下面那个密码弹窗 —— 免得在两个地方各写一份表单。
   * 依赖数组留空：openPassword 只调 setState，闭包不会过期。
   */
  useEffect(() => {
    const onOpenPassword = () => openPassword()
    window.addEventListener('wood:open-password', onOpenPassword)
    return () => window.removeEventListener('wood:open-password', onOpenPassword)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openPassword = () => {
    setOldPassword('')
    setNewPassword('')
    setResetCode('')
    setUseResetCode(false)
    setPasswordOpen(true)
  }

  const submitPassword = async () => {
    setSaving(true)
    try {
      if (useResetCode) {
        await resetPassword({
          username: username || 'admin',
          resetCode,
          newPassword,
        })
      } else {
        await changePassword(oldPassword, newPassword)
      }
      setPasswordOpen(false)
      /**
       * 改密码会让服务端把这个账号的 token_version 加一，
       * 也就是**当前这个 token 立刻作废**。所以不能只弹个提示继续用，
       * 必须清掉本地登录态、回登录页用新密码重登。
       */
      clearSession()
      navigate('/login', {
        replace: true,
        state: { notice: '密码已修改，请用新密码重新登录' },
      })
    } catch (err) {
      setToast({
        id: 'password-error',
        kind: 'error',
        message: err instanceof Error ? err.message : '修改失败',
        onClose: () => setToast(null),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="layout">
      <aside className={drawerOpen ? 'sidebar is-open' : 'sidebar'}>
        <div className="sidebar-brand">立川云木材管理系统</div>
        <nav className="sidebar-nav">
          {/* 首页独立，不归到任何分类里 */}
          <NavLink
            to={homeItem.to}
            end={homeItem.end}
            onClick={() => setDrawerOpen(false)}
            className={({ isActive }) =>
              isActive ? 'nav-item nav-item-active' : 'nav-item'
            }
          >
            <svg
              className="nav-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {homeItem.icon}
            </svg>
            <span>{homeItem.label}</span>
          </NavLink>

          {visibleGroups.map((group) => {
            const open = Boolean(openGroups[group.key])
            return (
              <div key={group.key} className={open ? 'nav-group is-open' : 'nav-group'}>
                <button
                  type="button"
                  className="nav-group-head"
                  aria-expanded={open}
                  title={group.hint}
                  onClick={() =>
                    setOpenGroups((prev) => ({ ...prev, [group.key]: !prev[group.key] }))
                  }
                >
                  <span className="nav-group-label">{group.label}</span>
                  <svg className="nav-group-chevron" viewBox="0 0 8 8" aria-hidden="true">
                    <path
                      d="M2.6 1.4 5.4 4l-2.8 2.6"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>

                <div className="nav-group-body">
                  <div className="nav-group-inner">
                    {group.items.map((item) => (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        end={item.end}
                        onClick={() => setDrawerOpen(false)}
                        className={({ isActive }) =>
                          isActive ? 'nav-item nav-item-active' : 'nav-item'
                        }
                      >
                        <svg
                          className="nav-icon"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          {item.icon}
                        </svg>
                        <span>{item.label}</span>
                      </NavLink>
                    ))}
                  </div>
                </div>
              </div>
            )
          })}
        </nav>
        <div className="sidebar-user-footer">
          <span className="sidebar-user-avatar" aria-hidden="true">
            {initial}
          </span>
          <span className="sidebar-user-copy">
            <strong>{username}</strong>
            <small>{ROLE_LABELS[role] ?? role}</small>
          </span>
        </div>
      </aside>

      {/* 手机上抽屉外的遮罩，点一下收起 */}
      {drawerOpen && (
        <div className="sidebar-mask" onClick={() => setDrawerOpen(false)} />
      )}

      <main className="content">
        <div className="topbar">
          {/*
            二级页（不在底部 4 个 Tab 上的页面）在手机端左上角给一个「‹ 返回」：
            手机上侧边栏收起来了、PWA 里也没有浏览器返回键，没这个按钮就只能靠底部 Tab 绕。
          */}
          {showBack && (
            <button
              type="button"
              className="topbar-back"
              aria-label="返回上一层"
              onClick={() => void goBack()}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M14.5 5.5 8 12l6.5 6.5" />
              </svg>
              <span>返回</span>
            </button>
          )}
          <button
            type="button"
            className="menu-toggle"
            aria-label="打开菜单"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen((open) => !open)}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
          {/* 手机上顶栏中间显示当前功能名（桌面端不显示） */}
          <span className="topbar-title">
            {location.pathname === '/' ? '首页' : labelOf(location.pathname)}
          </span>
          <nav className="app-breadcrumb" aria-label="面包屑">
            <span>立川云</span>
            <i>/</i>
            <span>{location.pathname === '/' ? '工作台' : labelOf(location.pathname)}</span>
          </nav>
          <div className="app-global-search" ref={searchRef}>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="10.5" cy="10.5" r="6.2" />
              <path d="m15.2 15.2 4.3 4.3" />
            </svg>
            <input
              value={globalSearch}
              placeholder="搜索菜单"
              onChange={(event) => {
                setGlobalSearch(event.target.value)
                setGlobalSearchOpen(true)
              }}
              onFocus={() => setGlobalSearchOpen(true)}
            />
            {globalSearchOpen ? (
              <div className="app-global-search-menu">
                {searchMenuItems.length > 0 ? (
                  searchMenuItems.map((item) => (
                    <button
                      key={item.to}
                      type="button"
                      onClick={() => {
                        setGlobalSearch('')
                        setGlobalSearchOpen(false)
                        navigate(item.to)
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
                        {item.icon}
                      </svg>
                      <span>{item.label}</span>
                      <small>{item.to}</small>
                    </button>
                  ))
                ) : (
                  <p>没有匹配的菜单</p>
                )}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="app-header-icon"
            aria-label="切换全屏"
            title="切换全屏"
            onClick={toggleFullscreen}
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
              <path d="M8.5 4H4v4.5M15.5 4H20v4.5M20 15.5V20h-4.5M8.5 20H4v-4.5" />
            </svg>
          </button>
          <div className="account" ref={accountRef}>
            <button
              type="button"
              className={menuOpen ? 'account-trigger account-trigger-open' : 'account-trigger'}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <span className="account-avatar" aria-hidden="true">
                {initial}
              </span>
              <span className="account-name">{username}</span>
              <svg
                className="account-chevron"
                viewBox="0 0 10 6"
                aria-hidden="true"
              >
                <path
                  d="M1 1.2 5 5 9 1.2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>

            {menuOpen && (
              <div
                className="account-menu"
                role="menu"
                ref={menuRef}
                onKeyDown={handleMenuKeyDown}
              >
                <button
                  type="button"
                  className="account-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    navigate('/me')
                  }}
                >
                  <svg
                    className="account-menu-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="8" r="3.6" />
                    <path d="M5 20c.8-3.4 3.6-5.4 7-5.4s6.2 2 7 5.4" />
                  </svg>
                  <span>我的</span>
                </button>
                <button
                  type="button"
                  className="account-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    openPassword()
                  }}
                >
                  <svg
                    className="account-menu-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <rect x="4.5" y="10.5" width="15" height="9.5" rx="2.6" />
                    <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" />
                    <path d="M12 14.2v2.4" />
                  </svg>
                  <span>修改密码</span>
                </button>
                <div className="account-menu-sep" />
                <button
                  type="button"
                  className="account-menu-item account-menu-item-danger"
                  role="menuitem"
                  onClick={handleLogout}
                >
                  <svg
                    className="account-menu-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M14.5 4h3.6A1.9 1.9 0 0 1 20 5.9v12.2a1.9 1.9 0 0 1-1.9 1.9h-3.6" />
                    <path d="M9.8 8.2 6 12l3.8 3.8" />
                    <path d="M6.4 12H15" />
                  </svg>
                  <span>退出登录</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* 功能索引：点开过的功能都在这里，像浏览器标签一样切换（首页不做索引） */}
        {visibleTabs.length > 0 && (
        <nav className="tabbar" aria-label="已打开的功能">
          {visibleTabs.map((tab) => (
            <div
              key={tab.path}
              className={
                tab.path === location.pathname ? 'tab-item tab-item-active' : 'tab-item'
              }
              onContextMenu={(event) => {
                event.preventDefault()
                setTabMenu({ x: event.clientX, y: event.clientY, path: tab.path })
              }}
            >
              <button
                type="button"
                className="tab-label"
                onClick={() => navigate(tab.path)}
              >
                {tab.label}
              </button>
              <button
                type="button"
                className="tab-close"
                aria-label={`关闭 ${tab.label}`}
                onClick={() => closeTab(tab.path)}
              >
                ×
              </button>
            </div>
          ))}
        </nav>
        )}

        {tabMenu ? (
          <div
            ref={tabMenuRef}
            className="tab-context-menu"
            style={{ left: tabMenu.x, top: tabMenu.y }}
            role="menu"
          >
            <button type="button" onClick={() => closeOtherTabs(tabMenu.path)}>
              关闭其他
            </button>
            <button type="button" onClick={closeAllTabs}>
              关闭所有
            </button>
          </div>
        ) : null}

        {/* 页面是按需加载的，切页面时先显示一个轻量加载态 */}
        {offlineBarVisible && (
          <div className={offlineBarFading ? 'offline-bar is-hiding' : 'offline-bar'}>
            当前离线，展示的是上次数据
          </div>
        )}
        {/*
          切页：外层这层 div 用 pathname 做 key —— 换页时整块重新挂载，
          CSS 的 page-in（140ms 淡入 + 8px 上移）就跑一遍，切页有"进场"的感觉。
          切页加载：顶上一条细进度条 + 一块骨架（比整页空白/一个转圈更像 App）。
        */}
        <PageContainer className="route-page-container">
          <div className="page-transition" key={location.pathname}>
            <Suspense fallback={<RouteProgress />}>
              <Outlet />
            </Suspense>
          </div>
        </PageContainer>
      </main>

      {/*
        手机端底部 Tab 栏。PC 端不显示（组件基类就是 display: none，
        只有 <768px 的媒体查询里才铺开），桌面端照旧用左边那条侧边栏。
      */}
      <BottomNav />

      {passwordOpen && (
        <div className="overlay" onClick={() => setPasswordOpen(false)}>
          <div
            className="modal modal-narrow modal-sheet"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <h2 className="modal-title">修改密码</h2>
              <button
                className="btn btn-sm btn-quiet"
                onClick={() => setPasswordOpen(false)}
              >
                关闭
              </button>
            </div>

            {useResetCode ? (
              <label className="field">
                <span>重置口令</span>
                <input
                  className="input"
                  type="password"
                  value={resetCode}
                  autoComplete="off"
                  onChange={(event) => setResetCode(event.target.value)}
                />
              </label>
            ) : (
              <label className="field">
                <span>原密码</span>
                <input
                  className="input"
                  type="password"
                  value={oldPassword}
                  autoComplete="current-password"
                  onChange={(event) => setOldPassword(event.target.value)}
                />
              </label>
            )}

            <label className="field" style={{ marginTop: 14 }}>
              <span>新密码（至少 6 位）</span>
              <input
                className="input"
                type="password"
                value={newPassword}
                autoComplete="new-password"
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </label>

            <div className="confirm-actions" style={{ marginTop: 22 }}>
              <button className="btn" onClick={() => setPasswordOpen(false)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void submitPassword()}
                disabled={saving}
              >
                {saving ? '保存中…' : '保存'}
              </button>
            </div>

            <button
              type="button"
              className="login-forgot"
              style={{ display: 'block', marginTop: 12 }}
              onClick={() => {
                setUseResetCode((prev) => !prev)
                setResetCode('')
                setOldPassword('')
              }}
            >
              {useResetCode ? '改回用原密码修改' : '忘记原密码？用重置口令修改'}
            </button>
          </div>
        </div>
      )}

      <ToastHost items={[toast]} />
    </div>
  )
}
