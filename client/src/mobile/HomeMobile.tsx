/**
 * 手机端首页：问候头 → 4 张数字卡（2×2）→ 待办 → 出库走势 → 库存构成
 * → 应收/应付（仅 admin/finance）→ 今日任务 → 8 格宫格。
 * 数据全部来自现有接口（home/summary + bales + shipments），不新增接口。
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  fetchBales,
  fetchHomeSummary,
  fetchShipments,
  getStoredUsername,
  type HomeCompositionDimension,
  type HomeSummary,
} from '../api'
import { useRole } from '../hooks/useRole'
import { can, canVisit, seesMoney } from '../permissions'
import { formatCubic, formatAmount } from '../utils/num'
import {
  MobileAvatar,
  MobileCard,
  MobileEmpty,
  MobileIcon,
  MobileList,
  MobileListItem,
  MobileSegmented,
  MobileSkeleton,
  useCountUp,
} from './components'

const PALETTE = ['#0071e3', '#34c759', '#ff9f0a', '#5e5ce6', '#40c8e0', '#8e8e93', '#bf5af2']

const TILES: Array<{ to: string; label: string; icon: 'box' | 'doc' | 'chart' | 'trash'; cap?: 'inbound.write' | 'outbound.write' | 'repack.write' | 'count.write' }> = [
  { to: '/inbound/new', label: '入库', icon: 'box', cap: 'inbound.write' },
  { to: '/outbound/new', label: '出库', icon: 'box', cap: 'outbound.write' },
  { to: '/bales', label: '码单', icon: 'doc' },
  { to: '/contracts', label: '合同', icon: 'doc' },
  { to: '/repack', label: '改包', icon: 'box', cap: 'repack.write' },
  { to: '/count', label: '盘点', icon: 'chart', cap: 'count.write' },
  { to: '/stock', label: '库存', icon: 'box' },
  { to: '/recycle', label: '回收站', icon: 'trash' },
]

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export default function HomeMobile() {
  const navigate = useNavigate()
  const role = useRole()
  const showMoney = seesMoney(role)
  const [summary, setSummary] = useState<HomeSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [days, setDays] = useState<'7' | '14' | '30'>('14')
  const [dimension, setDimension] = useState<HomeCompositionDimension>('spec')
  const [pending, setPending] = useState<{ labels: number; unlinked: number } | null>(null)

  useEffect(() => {
    let alive = true
    void fetchHomeSummary({ days: Number(days) as 7 | 14 | 30, dimension })
      .then((data) => alive && setSummary(data))
      .catch(() => undefined)
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [days, dimension])

  useEffect(() => {
    let alive = true
    void Promise.all([fetchBales({ limit: 1 }), fetchShipments({ unlinked: true, limit: 1 })])
      .then(([bales, ships]) =>
        alive && setPending({ labels: bales.total_in_stock, unlinked: ships.total }),
      )
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const todayIn = useCountUp(summary?.today_in_cubic ?? 0)
  const todayOut = useCountUp(summary?.today_out_cubic ?? 0)
  const stockCubic = useCountUp(summary?.total_stock_cubic ?? 0)
  const stockAmount = useCountUp(summary?.total_stock_amount ?? 0)

  const todayCount = useMemo(() => {
    const today = new Date()
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    return (summary?.recent_records ?? []).filter((r) => r.order_date === iso).length
  }, [summary])

  const trend = summary?.trend ?? []
  const trendMax = Math.max(0.0001, ...trend.map((d) => d.out_cubic))
  const composition = summary?.composition ?? []
  const compositionTotal = composition.reduce((sum, item) => sum + item.cubic, 0) || 1

  const tiles = TILES.filter((tile) =>
    tile.cap ? can(role, tile.cap) : canVisit(role, tile.to),
  )

  const now = new Date()
  const hour = now.getHours()
  const greet = hour < 6 ? '凌晨好' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'
  const dateText = `${now.getMonth() + 1}月${now.getDate()}日 ${WEEK[now.getDay()]}`

  return (
    <div className="m-stack">
      {/* ⑨ 问候头 */}
      <div className="m-hello">
        <div className="m-hello-main">
          <span className="m-hello-date">{dateText}</span>
          <span className="m-hello-name">
            {greet}，{getStoredUsername() || '你好'}
          </span>
        </div>
        <MobileAvatar name={getStoredUsername() || 'U'} />
      </div>

      {loading && !summary ? (
        <MobileSkeleton cards={2} />
      ) : (
        <>
          {/* 4 张数字卡 */}
          <div className="m-grid2">
            {[
              { label: '今日到货', value: formatCubic(todayIn), unit: '立方' },
              { label: '今日出库', value: formatCubic(todayOut), unit: '立方' },
              { label: '在库总量', value: formatCubic(stockCubic), unit: '立方' },
              showMoney
                ? { label: '库存总值', value: formatAmount(stockAmount), unit: '元' }
                : { label: '在库件数', value: String(summary?.total_stock_bundles ?? 0), unit: '件' },
            ].map((item) => (
              <div className="m-stat" key={item.label}>
                <span className="m-stat-label">{item.label}</span>
                <span className="m-num-lg">
                  {item.value}
                  <span className="m-unit">{item.unit}</span>
                </span>
              </div>
            ))}
          </div>

          {/* ② 8 格宫格：操作入口紧跟数字卡，不用往下找 */}
          <MobileCard title="全部功能">
            <div className="m-grid4">
              {tiles.map((tile) => (
                <button
                  type="button"
                  className="m-tile"
                  key={tile.to + tile.label}
                  onClick={() => navigate(tile.to)}
                >
                  <MobileIcon name={tile.icon} size={24} />
                  <span>{tile.label}</span>
                </button>
              ))}
            </div>
          </MobileCard>

          {/* ① 待办 */}
          <MobileCard title="待办">
            <button
              type="button"
              className={pending && pending.labels > 0 ? 'm-todo is-warn' : 'm-todo'}
              onClick={() => navigate('/bales')}
            >
              <span className="m-todo-label">待打印标签</span>
              <span className="m-todo-value">
                {pending ? pending.labels : '—'}
                <small>件</small>
              </span>
            </button>
            <button
              type="button"
              className={pending && pending.unlinked > 0 ? 'm-todo is-warn' : 'm-todo'}
              onClick={() => navigate('/bales')}
            >
              <span className="m-todo-label">未关联合同的提单</span>
              <span className="m-todo-value">
                {pending ? pending.unlinked : '—'}
                <small>张</small>
              </span>
            </button>
            <button type="button" className="m-todo" onClick={() => navigate('/inbound')}>
              <span className="m-todo-label">今日单据</span>
              <span className="m-todo-value">
                {todayCount}
                <small>张</small>
              </span>
            </button>
          </MobileCard>

          {/* ③ 出库走势 */}
          <MobileCard title="出库走势">
            <MobileSegmented
              value={days}
              onChange={setDays}
              options={[
                { value: '7', label: '7 天' },
                { value: '14', label: '14 天' },
                { value: '30', label: '30 天' },
              ]}
            />
            <div className="m-bars">
              {trend.map((day) => (
                <span
                  key={day.date}
                  className="m-bar"
                  style={{ height: `${day.out_cubic <= 0 ? 2 : Math.max(4, (day.out_cubic / trendMax) * 100)}%` }}
                  title={`${day.date}　${formatCubic(day.out_cubic)} 立方`}
                />
              ))}
            </div>
            <div className="m-bars-axis">
              <span>{trend[0]?.date?.slice(5) ?? ''}</span>
              <span>近 {days} 天累计 {formatCubic(summary?.outbound_30d_cubic ?? 0)} 立方</span>
              <span>{trend[trend.length - 1]?.date?.slice(5) ?? ''}</span>
            </div>
          </MobileCard>

          {/* ④ 库存构成 */}
          <MobileCard title="库存构成">
            <MobileSegmented
              value={dimension}
              onChange={setDimension}
              options={[
                { value: 'spec' as HomeCompositionDimension, label: '按规格' },
                { value: 'species' as HomeCompositionDimension, label: '按品名' },
                { value: 'grade' as HomeCompositionDimension, label: '按等级' },
              ]}
            />
            {composition.length === 0 ? (
              <MobileEmpty text="当前没有库存" />
            ) : (
              <>
                <div className="m-stack-bar">
                  {composition.map((item, index) => (
                    <span
                      key={item.label}
                      style={{
                        width: `${Math.max(1, (item.cubic / compositionTotal) * 100)}%`,
                        backgroundColor: PALETTE[index % PALETTE.length],
                      }}
                    />
                  ))}
                </div>
                <div className="m-legend">
                  {composition.slice(0, 4).map((item, index) => (
                    <div className="m-legend-row" key={item.label}>
                      <i className="m-dot" style={{ backgroundColor: PALETTE[index % PALETTE.length] }} />
                      <span className="m-legend-name">{item.label}</span>
                      <span className="m-legend-num">
                        {formatCubic(item.cubic)} m³ · {item.share}%
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </MobileCard>

          {/* ⑥ 应收 / 应付（仅 admin / finance） */}
          {showMoney ? (
            <MobileCard title="往来">
              <div className="m-money-pair">
                <button type="button" className="m-money" onClick={() => navigate('/settlement')}>
                  <span className="m-money-label">应收合计</span>
                  <span className="m-money-value">{formatAmount(summary?.receivable_total ?? 0)}</span>
                </button>
                <button type="button" className="m-money" onClick={() => navigate('/settlement')}>
                  <span className="m-money-label">应付合计</span>
                  <span className="m-money-value">{formatAmount(summary?.payable_total ?? 0)}</span>
                </button>
              </div>
            </MobileCard>
          ) : null}

          {/* 今日任务 */}
          <MobileCard title="今日任务">
            {(summary?.recent_records ?? []).length === 0 ? (
              <MobileEmpty
                text="今天还没有单据"
                actionLabel="去录入库"
                onAction={() => navigate('/inbound/new')}
              />
            ) : (
              <MobileList>
                {(summary?.recent_records ?? []).slice(0, 4).map((record, index) => (
                  <MobileListItem
                    key={`${record.order_no}-${index}`}
                    dense
                    title={record.order_no}
                    sub={`${record.partner || '—'} · ${record.type === 'in' ? '入库' : '出库'} ${formatCubic(record.total_cubic)} m³`}
                    trail={record.order_date?.slice(5) ?? ''}
                    onClick={() => navigate(record.type === 'in' ? '/inbound' : '/outbound')}
                  />
                ))}
              </MobileList>
            )}
          </MobileCard>

        </>
      )}
    </div>
  )
}
