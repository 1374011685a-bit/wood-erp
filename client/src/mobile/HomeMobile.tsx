/**
 * 手机端首页（大厂工具 App 风）：
 * 渐变头（今日入库/出库）→ 大图表卡（上浮压住渐变）→ 分组彩色宫格 → 底部灰字。
 * 数据全来自 fetchHomeSummary（走势/构成），宫格按角色权限过滤。
 */
import { useEffect, useState } from 'react'
import { fetchHomeSummary, type HomeSummary } from '../api'
import { useRole } from '../hooks/useRole'
import { can, canVisit, seesMoney } from '../permissions'
import { formatCubic, formatAmount } from '../utils/num'
import { readListCache, writeListCache } from '../utils/listCache'
import {
  MobileIcon,
  MobileRefreshBar,
  MobileSkeleton,
  useCountUp,
} from './components'
import { useMobileNavigate } from './useMobileNavigate'
import { useMobileScrollMemory } from './useMobileScrollMemory'

type Tile = {
  to: string
  label: string
  icon: 'box' | 'doc' | 'chart' | 'trash' | 'search'
  tone: 'orange' | 'red' | 'green' | 'blue' | 'indigo'
  cap?: 'inbound.write' | 'outbound.write' | 'repack.write' | 'count.write' | 'contract.write'
}

/** 分组 = 功能模块（每组一张白卡）；每个入口自己的渐变色由 tone 决定 */
const GROUPS: Array<{ title: string; tiles: Tile[] }> = [
  {
    title: '采购管理',
    tiles: [
      { to: '/inbound/new', label: '入库', icon: 'box', tone: 'orange', cap: 'inbound.write' },
      { to: '/contracts', label: '合同', icon: 'doc', tone: 'orange', cap: 'contract.write' },
    ],
  },
  {
    title: '销售管理',
    tiles: [
      { to: '/outbound/new', label: '出库', icon: 'box', tone: 'red', cap: 'outbound.write' },
      { to: '/bales', label: '码单', icon: 'doc', tone: 'green' },
      { to: '/repack', label: '改包', icon: 'box', tone: 'blue', cap: 'repack.write' },
    ],
  },
  {
    title: '库存管理',
    tiles: [
      { to: '/stock', label: '库存', icon: 'box', tone: 'indigo' },
      { to: '/count', label: '盘点', icon: 'chart', tone: 'indigo', cap: 'count.write' },
      { to: '/bales', label: '打印', icon: 'doc', tone: 'green' },
    ],
  },
  {
    title: '其他',
    tiles: [
      { to: '/records', label: '流水', icon: 'chart', tone: 'indigo' },
      { to: '/recycle', label: '回收站', icon: 'trash', tone: 'orange' },
      { to: '/outbound/new?scan=1', label: '扫码', icon: 'search', tone: 'blue', cap: 'outbound.write' },
    ],
  },
]

export default function HomeMobile() {
  const navigate = useMobileNavigate()
  const role = useRole()
  const showMoney = seesMoney(role)
  const initialCache = readListCache<HomeSummary>('m:home:7:spec')
  const [summary, setSummary] = useState<HomeSummary | null>(initialCache ?? null)
  const [loading, setLoading] = useState(!initialCache)
  const [refreshing, setRefreshing] = useState(Boolean(initialCache))
  const [days, setDays] = useState<'7' | '14' | '30'>('7')
  useMobileScrollMemory('/', !loading)

  useEffect(() => {
    let alive = true
    const cacheKey = `m:home:${days}:spec`
    const cached = readListCache<HomeSummary>(cacheKey)
    if (cached) {
      setSummary(cached)
      setLoading(false)
      setRefreshing(true)
    } else {
      setRefreshing(true)
    }
    void fetchHomeSummary({ days: Number(days) as 7 | 14 | 30, dimension: 'spec' })
      .then((data) => {
        if (!alive) return
        setSummary(data)
        writeListCache(cacheKey, data)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!alive) return
        setLoading(false)
        setRefreshing(false)
      })
    return () => {
      alive = false
    }
  }, [days])

  const todayIn = useCountUp(summary?.today_in_cubic ?? 0)
  const todayOut = useCountUp(summary?.today_out_cubic ?? 0)

  const trend = summary?.trend ?? []
  const trendMax = Math.max(0.0001, ...trend.map((day) => day.out_cubic))
  const sum = trend.reduce((acc, day) => acc + day.out_cubic, 0)

  const groups = GROUPS.map((group) => ({
    ...group,
    tiles: group.tiles.filter((tile) =>
      tile.cap ? can(role, tile.cap) : canVisit(role, tile.to),
    ),
  })).filter((group) => group.tiles.length > 0)

  if (loading && !summary) {
    return (
      <div className="m-home m-home-enter" style={{ padding: 16 }}>
        <MobileSkeleton cards={2} />
      </div>
    )
  }

  return (
    <div className="m-home m-home-enter" style={{ paddingBottom: 8 }}>
      <MobileRefreshBar active={refreshing} />
      {/* 1 渐变头 */}
      <div className="m-hero">
        <div className="m-hero-title">立川云 · 木材管理</div>
        <div className="m-hero-stats">
          <div className="m-hero-stat">
            <div className="m-hero-label">今日入库</div>
            <div className="m-hero-value">
              {formatCubic(todayIn)}
              <small>m³</small>
            </div>
          </div>
          <div className="m-hero-stat">
            <div className="m-hero-label">今日出库</div>
            <div className="m-hero-value">
              {formatCubic(todayOut)}
              <small>m³</small>
            </div>
          </div>
        </div>
      </div>

      {/* 2 大图表卡（上浮 40px） */}
      <div className="m-chart-card">
        <div className="m-chart-head">
          <span className="m-chart-title">近 {days} 天出库</span>
          <span className="m-segmented" style={{ width: 'auto' }}>
            {(['7', '14', '30'] as const).map((value) => (
              <button
                type="button"
                key={value}
                className={value === days ? 'm-seg-item is-on' : 'm-seg-item'}
                style={{ flex: '0 0 auto', padding: '0 10px' }}
                onClick={() => setDays(value)}
              >
                {value} 天
              </button>
            ))}
          </span>
        </div>
        {sum <= 0 ? (
          /* 没有出库数据：一组灰色骨架柱（比一根平线有质感） */
          <div>
            <div className="m-chart-skeleton" aria-hidden="true">
              {[38, 62, 26, 78, 48, 66, 88].map((height, index) => (
                <span key={index} style={{ height: `${height}%` }} />
              ))}
            </div>
            <div className="m-bars-axis">
              <span>{trend[0]?.date?.slice(5) ?? ''}</span>
              <span>暂无出库数据</span>
              <span>{trend[trend.length - 1]?.date?.slice(5) ?? ''}</span>
            </div>
          </div>
        ) : (
          <>
            <div className="m-bars" style={{ height: 160 }}>
              {trend.map((day) => (
                <span
                  key={day.date}
                  className="m-bar"
                  style={{
                    height: `${day.out_cubic <= 0 ? 2 : Math.max(6, (day.out_cubic / trendMax) * 100)}%`,
                  }}
                  title={`${day.date}　${formatCubic(day.out_cubic)} m³`}
                />
              ))}
            </div>
            <div className="m-bars-axis">
              <span>{trend[0]?.date?.slice(5) ?? ''}</span>
              <span>合计 {formatCubic(sum)} m³</span>
              <span>{trend[trend.length - 1]?.date?.slice(5) ?? ''}</span>
            </div>
          </>
        )}
      </div>

      {/* 3 分组彩色宫格 */}
      {groups.map((group) => (
        <div className="m-mod-card" key={group.title}>
          <div className="m-mod-title">{group.title}</div>
          <div className="m-mod-row">
            {group.tiles.map((tile) => (
              <button
                type="button"
                className={`m-app-icon is-${tile.tone}`}
                key={`${tile.to}#${tile.label}`}
                onClick={() => {
                  /* 进表单先把列表压进历史：物理返回和左上角返回都回列表 */
                  navigate(tile.to)
                }}
              >
                <i>
                  <MobileIcon name={tile.icon} size={28} />
                </i>
                <span>{tile.label}</span>
              </button>
            ))}
          </div>
        </div>
      ))}

      {/* 5 底部灰字：应收/应付（只给 admin / finance） */}
      {showMoney ? (
        <button type="button" className="m-foot-note" onClick={() => navigate('/settlement')}>
          应收 {formatAmount(summary?.receivable_total ?? 0)} · 应付{' '}
          {formatAmount(summary?.payable_total ?? 0)}
        </button>
      ) : null}
    </div>
  )
}
