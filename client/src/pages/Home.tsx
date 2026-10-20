import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  fetchBales,
  fetchContractPicker,
  fetchHomeSummary,
  type HomeCompositionDimension,
  type HomeSummary,
} from '../api'
import { PageHead, ToastHost } from '../components/Ui'
import CommerceWorkbench, {
  type CommerceQuickAction,
} from '../components/CommerceWorkbench'
import { formatCubic } from '../utils/num'
import { useRole } from '../hooks/useRole'
import { can, canVisit, seesMoney } from '../permissions'
import type { Role } from '../permissions'
import { tapFeedback } from '../utils/haptics'

const formatMoney = (value: number) =>
  value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const formatInt = (value: number) => Math.round(value).toLocaleString('zh-CN')

/**
 * 手机端首页的 6 个功能入口（桌面端不渲染 —— 侧边栏里本来就都有）。
 *
 * 口径和「单据」入口页一样：进得去才给格子。
 *   入库 / 出库 是**录单**（今天主要干的活），所以直接进表单，要写权限；
 *   码单 / 合同 / 库存 是**看**（所有登录角色都能进）。
 */
type AppTileCap = 'inbound.write' | 'outbound.write' | 'repack.write'

const APP_TILES: { to: string; label: string; cap?: AppTileCap; icon: ReactNode }[] = [
  {
    to: '/inbound/new',
    label: '入库',
    cap: 'inbound.write',
    icon: (
      <>
        <path d="M12 3.6v9.8" />
        <path d="M8.4 9.8 12 13.4l3.6-3.6" />
        <path d="M4.6 16.4v2.4a1.6 1.6 0 0 0 1.6 1.6h11.6a1.6 1.6 0 0 0 1.6-1.6v-2.4" />
      </>
    ),
  },
  {
    to: '/outbound/new',
    label: '出库',
    cap: 'outbound.write',
    icon: (
      <>
        <path d="M12 13.4V3.6" />
        <path d="M8.4 7.2 12 3.6l3.6 3.6" />
        <path d="M4.6 16.4v2.4a1.6 1.6 0 0 0 1.6 1.6h11.6a1.6 1.6 0 0 0 1.6-1.6v-2.4" />
      </>
    ),
  },
  {
    /*
     * 扫码：仓管一天里点得最多的一格。
     * 直接落到出库表单并把扫码枪打开（?scan=1 由出库页读），
     * 省掉「进出库 → 点扫一扫」这两下。
     */
    to: '/outbound/new?scan=1',
    label: '扫码',
    cap: 'outbound.write',
    icon: (
      <>
        <path d="M4 8.4V5.8A1.8 1.8 0 0 1 5.8 4h2.6" />
        <path d="M15.6 4h2.6A1.8 1.8 0 0 1 20 5.8v2.6" />
        <path d="M20 15.6v2.6a1.8 1.8 0 0 1-1.8 1.8h-2.6" />
        <path d="M8.4 20H5.8A1.8 1.8 0 0 1 4 18.2v-2.6" />
        <path d="M4.8 12h14.4" />
      </>
    ),
  },
  {
    to: '/bales',
    label: '码单',
    icon: (
      <>
        <path d="M11.5 3.9h7.6a1 1 0 0 1 1 1v7.6a1 1 0 0 1-.3.7l-7.2 7.2a1 1 0 0 1-1.4 0l-6.6-6.6a1 1 0 0 1 0-1.4l6.9-6.9a1 1 0 0 1 .7-.3z" />
        <circle cx="15.6" cy="8.4" r="1.3" />
      </>
    ),
  },
  {
    /*
     * 打印：标签打印的入口。
     * 落到码单列表（每行都能点「打印标签」），因为要先挑包再打印。
     */
    to: '/bales',
    label: '打印',
    icon: (
      <>
        <path d="M7 9V4.8h10V9" />
        <path d="M7 18H5.4A1.4 1.4 0 0 1 4 16.6v-4.8a1.4 1.4 0 0 1 1.4-1.4h13.2A1.4 1.4 0 0 1 20 11.8v4.8a1.4 1.4 0 0 1-1.4 1.4H17" />
        <path d="M7 14.6h10v4.6H7z" />
      </>
    ),
  },
  {
    to: '/repack',
    label: '改包',
    cap: 'repack.write',
    icon: (
      <>
        <path d="M7 8.6h8.4a3 3 0 0 1 0 6H7" />
        <path d="M9.5 6 7 8.6l2.5 2.6" />
        <path d="M14.5 18 17 15.4l-2.5-2.6" />
      </>
    ),
  },
  {
    to: '/contracts',
    label: '合同',
    icon: (
      <>
        <path d="M6.6 3.5h7.1l4.3 4.3v12.7H6.6z" />
        <path d="M13.6 3.5v4.4h4.4" />
        <path d="M9.4 13h5.2M9.4 16.4h5.2" />
      </>
    ),
  },
  {
    to: '/stock',
    label: '库存',
    icon: (
      <>
        <path d="M3.7 7.5 12 3.4l8.3 4.1L12 11.6z" />
        <path d="M3.7 7.5v9.1l8.3 4 8.3-4V7.5" />
        <path d="M12 11.6v9" />
      </>
    ),
  },
]

/**
 * 手机端首页宫格的**角色白名单**（按「名字」列，因为扫码/码单/打印里有两条指向同一路径）。
 *
 * 只列出来的角色受这份名单约束；没列的角色（管理员 / 财务 / 只读）沿用老口径 ——
 * 「有权限才给格子」，所以只读角色看到的就是 码单 / 打印 / 合同 / 库存 这四个。
 *
 * 白名单只是"上限"，格子本身还要过一遍权限判断（比如仓管的改包要 repack.write）。
 */
const TILE_ALLOW: Partial<Record<Role, string[]>> = {
  warehouse: ['入库', '出库', '扫码', '码单', '打印', '改包'],
  sales: ['合同', '入库', '出库', '码单', '库存'],
}

/**
 * 数字跑动：从上一个值滚到新值，缓出收尾（苹果那种「不弹、不急停」的手感）。
 * 这里故意不判 prefers-reduced-motion：跑动只是一次数字滚动、位移很小，
 * 而且首页的观感就靠它，所以始终执行（大位移动画才需要尊重那个设置）。
 */
function useCountUp(target: number, duration = 720) {
  const [display, setDisplay] = useState(target)
  const currentRef = useRef(target)
  const frameRef = useRef(0)

  useEffect(() => {
    const from = currentRef.current
    if (from === target) {
      currentRef.current = target
      setDisplay(target)
      return
    }

    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - (1 - t) ** 3
      const value = from + (target - from) * eased
      currentRef.current = value
      setDisplay(value)
      if (t < 1) frameRef.current = requestAnimationFrame(tick)
      else currentRef.current = target
    }
    frameRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frameRef.current)
  }, [target, duration])

  return display
}

export default function Home() {
  /**
   * 看不到金额的角色：库存金额 / 应收应付 / 最近到货金额 / 流水金额 全都不渲染，
   * 主视觉那颗大数字改成显示立方。
   * 这些字段后端也不会返回（见 middleware/permissions.js 的 stripMoney）。
   */
  const money = seesMoney(useRole())
  /** 首页那三个「新增…」按钮按能力显示 */
  const role = useRole()
  const canWrite = (cap: 'inbound.write' | 'outbound.write' | 'count.write') =>
    can(role, cap)

  const navigate = useNavigate()
  const [summary, setSummary] = useState<HomeSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [days, setDays] = useState<7 | 14 | 30>(7)
  const [dimension, setDimension] = useState<HomeCompositionDimension>('spec')

  const load = useCallback(async (nextDays: number, nextDimension: string) => {
    setLoading(true)
    setError('')
    try {
      setSummary(
        await fetchHomeSummary({
          days: nextDays as 7 | 14 | 30,
          dimension: nextDimension as HomeCompositionDimension,
        }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(days, dimension)
  }, [load, days, dimension])

  /**
   * 业务员首页要的两个数，首页汇总接口里没有：
   *   - 合同未到货：把「合同选择器」那份列表的 left_cubic 加起来（合同超过一页就继续翻）
   *   - 在库包数：包列表接口顺手带的 total_in_stock（只要 1 条的正文，不拉整表）
   * 只有业务员会去取，其它角色一次多余的请求都不发。
   */
  const [pendingCubic, setPendingCubic] = useState<number | null>(null)
  const [inStockBales, setInStockBales] = useState<number | null>(null)
  const salesSeq = useRef(0)

  const loadSalesExtras = useCallback(async () => {
    if (role !== 'sales') return
    const seq = ++salesSeq.current
    const alive = () => salesSeq.current === seq

    try {
      const first = await fetchContractPicker({ limit: 200 })
      let sum = first.rows.reduce((acc, row) => acc + (row.left_cubic || 0), 0)
      let count = first.rows.length
      // 合同多于 200 张就接着翻（最多 10 页 = 2000 张，兜住打转的可能）
      for (let page = 1; count < first.total && page < 10; page += 1) {
        const next = await fetchContractPicker({ limit: 200, offset: page * 200 })
        if (next.rows.length === 0) break
        sum += next.rows.reduce((acc, row) => acc + (row.left_cubic || 0), 0)
        count += next.rows.length
      }
      if (alive()) setPendingCubic(Math.round(sum * 10000) / 10000)
    } catch {
      // 拿不到就让它显示「—」，不打断首页其它内容
    }

    try {
      const bales = await fetchBales({ limit: 1 })
      if (alive()) setInStockBales(bales.total_in_stock)
    } catch {
      /* 同上 */
    }
  }, [role])

  useEffect(() => {
    void loadSalesExtras()
  }, [loadSalesExtras])

  // 数字跑动：主数字 + 四张小卡
  const heroAmount = useCountUp(summary?.total_stock_amount ?? 0)
  const heroCubic = useCountUp(summary?.total_stock_cubic ?? 0)
  const heroBundles = useCountUp(summary?.total_stock_bundles ?? 0)
  const todayIn = useCountUp(summary?.today_in_cubic ?? 0, 560)
  const todayOut = useCountUp(summary?.today_out_cubic ?? 0, 560)
  const out30 = useCountUp(summary?.outbound_30d_cubic ?? 0, 560)

  /**
   * 手机端首页的格子：先过角色白名单（仓管 / 业务员各一套），
   * 再按权限收一遍 —— 没权限的入口不显示（和侧边栏一个口径）。
   * 有白名单的角色按名单里的顺序排（业务员最常用的「合同」排在最前面）。
   */
  const tileAllow = TILE_ALLOW[role]
  const appTiles = APP_TILES.filter((tile) => {
    const allow = tileAllow
    if (allow && !allow.includes(tile.label)) return false
    return tile.cap ? can(role, tile.cap) : canVisit(role, tile.to)
  }).sort((a, b) =>
    tileAllow ? tileAllow.indexOf(a.label) - tileAllow.indexOf(b.label) : 0,
  )

  const quickIcon = (icon: ReactNode) => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {icon}
    </svg>
  )

  const commerceQuickActions: CommerceQuickAction[] = [
    ...appTiles
      .filter((tile) => ['入库', '出库', '扫码'].includes(tile.label))
      .map((tile) => ({
        to: tile.to,
        label: tile.label,
        icon: quickIcon(tile.icon),
      })),
    ...(canWrite('count.write')
      ? [
          {
            to: '/count',
            label: '盘点',
            icon: quickIcon(
              <>
                <path d="M6.5 5.5h11v13h-11z" />
                <path d="M9 9h6M9 12h6M9 15h4" />
              </>,
            ),
          },
        ]
      : []),
    ...appTiles
      .filter((tile) => ['码单', '合同', '库存'].includes(tile.label))
      .map((tile) => ({
        to: tile.to,
        label: tile.label,
        icon: quickIcon(tile.icon),
      })),
  ].slice(0, 6)

  /**
   * 手机端首页的 4 张数字卡：**按角色给不同的 4 个数**。
   *
   * 桌面那套看板不看这里（还是同一份"老板视角"，一行没动）；手机上换成各角色
   * 打开就想看到的那几个数：
   *   仓管  → 今天到了多少、发走多少、库里还剩多少
   *   业务员→ 合同还差多少没到、出得怎么样、库里压着多少包
   *   财务 / 管理员 → 原来那四张（带金额）
   *   只读  → 不带金额的四张大数
   * 看不到金额的角色后端根本不返回金额字段，这里也不会去读。
   */
  const appCards: Array<{ label: string; value: string; unit: string; hint?: string }> =
    (() => {
      /** summary 还没回来时统一显示「—」，卡片高度不跳 */
      const num = (value: number, fmt: (n: number) => string) =>
        summary ? fmt(value) : '—'

      if (role === 'warehouse') {
        return [
          { label: '今日到货', value: num(todayIn, formatCubic), unit: '立方' },
          { label: '今日出库', value: num(todayOut, formatCubic), unit: '立方' },
          { label: '在库总量', value: num(heroCubic, formatCubic), unit: '立方' },
          { label: '在库件数', value: num(heroBundles, formatInt), unit: '件' },
        ]
      }

      if (role === 'sales') {
        return [
          {
            label: '合同未到货',
            value: pendingCubic === null ? '—' : formatCubic(pendingCubic),
            unit: '立方',
          },
          { label: '今日出库', value: num(todayOut, formatCubic), unit: '立方' },
          {
            label: '在库包数',
            value: inStockBales === null ? '—' : formatInt(inStockBales),
            unit: '包',
          },
          { label: '近 30 天出库', value: num(out30, formatCubic), unit: '立方' },
        ]
      }

      if (role === 'viewer') {
        return [
          { label: '在库总量', value: num(heroCubic, formatCubic), unit: '立方' },
          { label: '今日入库', value: num(todayIn, formatCubic), unit: '立方' },
          { label: '今日出库', value: num(todayOut, formatCubic), unit: '立方' },
          { label: '近 30 天出库', value: num(out30, formatCubic), unit: '立方' },
        ]
      }

      // 管理员 / 财务：原来那四张
      return [
        {
          label: '今日入库',
          value: num(todayIn, formatCubic),
          unit: '立方',
          hint: money ? `${num(summary?.today_in_amount ?? 0, formatMoney)} 元` : undefined,
        },
        {
          label: '今日出库',
          value: num(todayOut, formatCubic),
          unit: '立方',
          hint: money ? `${num(summary?.today_out_amount ?? 0, formatMoney)} 元` : undefined,
        },
        {
          label: '库存总量',
          value: num(heroCubic, formatCubic),
          unit: '立方',
          hint: `共 ${num(heroBundles, formatInt)} 件`,
        },
        money
          ? { label: '库存总值', value: num(heroAmount, formatMoney), unit: '元' }
          : { label: '库存件数', value: num(heroBundles, formatInt), unit: '件' },
      ]
    })()

  return (
    // .page-home 只用来做「手机端要收哪些桌面块」的样式作用域（见 index.css 末尾）
    <section className="page-home">
      <PageHead
        title="工作台"
        subtitle="经营数据、常用操作与业务动态总览"
        extra={
          <>
            {/*
              三个「新增…」在手机端收起来（宫格里有同样三个入口），留一个刷新。
              见 index.css 里 `.page-home .home-new-actions` 那条移动端规则。
            */}
            <span className="home-new-actions">
              {/* 没权限的功能不给入口，免得点进去被弹回来 */}
              {canWrite('inbound.write') && (
                <button className="btn btn-sm" onClick={() => navigate('/inbound/new')}>
                  新增入库
                </button>
              )}
              {canWrite('outbound.write') && (
                <button className="btn btn-sm" onClick={() => navigate('/outbound/new')}>
                  新增出库
                </button>
              )}
              {canWrite('count.write') && (
                <button className="btn btn-sm" onClick={() => navigate('/count')}>
                  新增盘点
                </button>
              )}
            </span>
            <button
              className="btn"
              onClick={() => {
                void load(days, dimension)
                // 业务员那两张卡是单独取的，刷新要一起跟
                void loadSalesExtras()
              }}
              disabled={loading}
            >
              刷新
            </button>
          </>
        }
      />

      <ToastHost
        items={[
          error
            ? {
                id: 'home-error',
                kind: 'error' as const,
                message: error,
                onClose: () => setError(''),
              }
            : null,
        ]}
      />

      {/*
        手机端（< 768px）的 App 版首页：上面 4 张数字卡、下面 6 个功能入口。
        桌面端完全不渲染 —— .app-home 的基类就是 display: none，
        只有移动端媒体查询里才铺开（和底部 Tab 栏一套做法）。
      */}
      <div className="app-home">
        <div className="app-cards">
          {appCards.map((card) => (
            <div className="app-card" key={card.label}>
              <span className="app-card-label">{card.label}</span>
              <span className="app-card-value">
                {card.value}
                <small>{card.unit}</small>
              </span>
              {card.hint && <span className="app-card-hint">{card.hint}</span>}
            </div>
          ))}
        </div>

        <div className="app-grid">
          {appTiles.map((tile) => (
            <button
              // 扫码 / 打印可能指向同一个路径（打印落到码单），所以 key 用「路径+名字」
              key={`${tile.to}#${tile.label}`}
              type="button"
              className="app-tile"
              onClick={() => {
                tapFeedback()
                navigate(tile.to)
              }}
            >
              <svg
                className="app-tile-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                {tile.icon}
              </svg>
              <span>{tile.label}</span>
            </button>
          ))}
        </div>
      </div>

      <CommerceWorkbench
        summary={summary}
        loading={loading}
        money={money}
        days={days}
        onDaysChange={setDays}
        dimension={dimension}
        onDimensionChange={setDimension}
        quickActions={commerceQuickActions}
      />
    </section>
  )
}
