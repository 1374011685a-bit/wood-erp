import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  fetchHomeSummary,
  type HomeCompositionDimension,
  type HomeSummary,
} from '../api'
import { EmptyState, Loading, PageHead, ToastHost } from '../components/Ui'
import { formatCubic } from '../utils/num'

const formatMoney = (value: number) =>
  value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const formatInt = (value: number) => Math.round(value).toLocaleString('zh-CN')

const typeLabel = (type: 'in' | 'out') => (type === 'in' ? '入库' : '出库')

/** 库存构成的配色：苹果系统色，压暗饱和度 */
const PALETTE = ['#0a84ff', '#30d158', '#ff9f0a', '#5e5ce6', '#40c8e0', '#8e8e93', '#bf5af2']

const PERIODS: Array<7 | 14 | 30> = [7, 14, 30]

const DIMENSIONS: Array<{ key: HomeCompositionDimension; label: string }> = [
  { key: 'spec', label: '按规格' },
  { key: 'species', label: '按品名' },
  { key: 'grade', label: '按等级' },
]

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

/** 环比 / 同比小标签：正绿负橙，没有基数就显示「—」 */
function DeltaChip({ label, percent }: { label: string; percent: number | null }) {
  const tone = percent === null ? '' : percent > 0 ? ' is-up' : percent < 0 ? ' is-down' : ''
  return (
    <span className={`delta-chip${tone}`}>
      {label} {percent === null ? '—' : `${percent > 0 ? '+' : ''}${percent}%`}
    </span>
  )
}

export default function Home() {
  const navigate = useNavigate()
  const [summary, setSummary] = useState<HomeSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [days, setDays] = useState<7 | 14 | 30>(14)
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

  const records = summary?.recent_records ?? []
  const trend = summary?.trend ?? []
  const composition = summary?.composition ?? []
  const compare = summary?.compare
  const arrival = summary?.recent_arrival ?? null

  // 走势图只画出库：进货是一次一大批，和日常出货同一根柱子上量级差太多
  const trendMax = Math.max(0.0001, ...trend.map((day) => day.out_cubic))
  const barHeight = (value: number) =>
    value <= 0 ? '2px' : `${Math.max(3, (value / trendMax) * 100)}%`

  // 数字跑动：主数字 + 四张小卡
  const heroAmount = useCountUp(summary?.total_stock_amount ?? 0)
  const heroCubic = useCountUp(summary?.total_stock_cubic ?? 0)
  const heroBundles = useCountUp(summary?.total_stock_bundles ?? 0)
  const receivable = useCountUp(summary?.receivable_total ?? 0, 560)
  const payable = useCountUp(summary?.payable_total ?? 0, 560)
  const todayOut = useCountUp(summary?.today_out_cubic ?? 0, 560)
  const out30 = useCountUp(summary?.outbound_30d_cubic ?? 0, 560)

  const delta = summary?.stock_delta_cubic ?? 0
  const supplyDays = summary?.days_of_supply ?? null

  return (
    <section>
      <PageHead
        title="首页"
        subtitle="库存、出货与应收的整体概览"
        extra={
          <>
            <button className="btn btn-sm" onClick={() => navigate('/inbound/new')}>
              新增入库
            </button>
            <button className="btn btn-sm" onClick={() => navigate('/outbound/new')}>
              新增出库
            </button>
            <button className="btn btn-sm" onClick={() => navigate('/count')}>
              新增盘点
            </button>
            <button
              className="btn"
              onClick={() => void load(days, dimension)}
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

      <div className="dash">
        {/* 主视觉：手里的货 + 最近到货 */}
        <div className="dash-hero">
          <div className="hero-head">
            <span className="hero-label">当前库存</span>
            {supplyDays !== null && (
              <span className="hero-chip">可售约 {supplyDays} 天</span>
            )}
          </div>

          <div className="hero-value">
            {summary ? formatMoney(heroAmount) : '—'}
            <span className="hero-unit">元</span>
          </div>

          <div className="hero-meta">
            <span>
              <b>{summary ? formatCubic(heroCubic) : '—'}</b> 立方
            </span>
            <span className="hero-sep" />
            <span>
              共 <b>{summary ? formatInt(heroBundles) : '—'}</b> 件
            </span>
            <span className="hero-sep" />
            <span className={delta > 0 ? 'hero-delta is-up' : delta < 0 ? 'hero-delta is-down' : 'hero-delta'}>
              较昨日 {delta > 0 ? '+' : ''}
              {formatCubic(delta)} 立方
            </span>
          </div>

          {summary && summary.daily_out_cubic > 0 && (
            <p className="hero-note">
              按近 30 天日均出库 {formatCubic(summary.daily_out_cubic)} 立方估算（实际卖了{' '}
              {summary.sold_days} 天）
            </p>
          )}

          <div className="arrival">
            <div className="arrival-head">
              <span className="arrival-title">最近到货</span>
              <span className="arrival-count">
                近一年 {summary?.arrival_batches_365 ?? 0} 批
              </span>
            </div>
            {arrival ? (
              <>
                <div className="arrival-main">
                  <span className="arrival-cubic">{formatCubic(arrival.cubic)} 立方</span>
                  <span className="arrival-amount">
                    {formatMoney(arrival.amount)} 元
                  </span>
                </div>
                <div className="arrival-meta">
                  <span>{arrival.order_no}</span>
                  <span className="hero-sep" />
                  <span>{arrival.supplier || '—'}</span>
                  <span className="hero-sep" />
                  <span>
                    {arrival.order_date}
                    {arrival.days_ago === 0
                      ? '（今天）'
                      : arrival.days_ago !== null
                        ? `（${arrival.days_ago} 天前）`
                        : ''}
                  </span>
                </div>
              </>
            ) : (
              <p className="arrival-empty">还没有到货记录</p>
            )}
          </div>
        </div>

        {/* 侧栏：钱 + 出货节奏 */}
        <div className="dash-side">
          <button
            type="button"
            className="mini-card"
            onClick={() => navigate('/settlement')}
          >
            <span className="mini-label">应收合计</span>
            <span className="mini-value">
              {summary ? formatMoney(receivable) : '—'}
            </span>
            <span className="mini-hint">去对账 ›</span>
          </button>

          <button
            type="button"
            className="mini-card"
            onClick={() => navigate('/settlement')}
          >
            <span className="mini-label">应付合计</span>
            <span className="mini-value">{summary ? formatMoney(payable) : '—'}</span>
            <span className="mini-hint">去对账 ›</span>
          </button>

          <div className="mini-card is-static">
            <span className="mini-label">今日出库</span>
            <span className="mini-value">
              {summary ? formatCubic(todayOut) : '—'}
              <small>立方</small>
            </span>
            <span className="mini-hint">
              {summary ? formatMoney(summary.today_out_amount) : '—'} 元
            </span>
          </div>

          <div className="mini-card is-static">
            <span className="mini-label">近 30 天出库</span>
            <span className="mini-value">
              {summary ? formatCubic(out30) : '—'}
              <small>立方</small>
            </span>
            <span className="mini-hint">
              日均 {summary ? formatCubic(summary.daily_out_cubic) : '—'} 立方
            </span>
          </div>
        </div>
      </div>

      {/* 出货走势：只画出库，进货用顶部小标记 */}
      <div className="card">
        <div className="card-head">
          <h2 className="section-title">出库走势</h2>
          <div className="segmented is-sm" role="tablist" aria-label="走势周期">
            {PERIODS.map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={days === value}
                className={days === value ? 'segmented-item is-on' : 'segmented-item'}
                onClick={() => setDays(value)}
              >
                {value} 天
              </button>
            ))}
          </div>
        </div>

        <div className="chart-stats">
          <span className="chart-figure">
            本期出库 <b>{compare ? formatCubic(compare.out.cubic) : '—'}</b> 立方
          </span>
          <DeltaChip label="环比" percent={compare?.out.mom_percent ?? null} />
          <DeltaChip label="同比" percent={compare?.out.yoy_percent ?? null} />
          <span className="trend-foot-inline">
            <i className="trend-dot is-out" />
            出库
            <i className="trend-dot is-arrival" />
            到货
          </span>
        </div>

        <div className="trend">
          {trend.map((day) => (
            <div
              className="trend-day"
              key={day.date}
              title={`${day.date}\n出库 ${formatCubic(day.out_cubic)} 立方${
                day.in_cubic > 0 ? `\n到货 ${formatCubic(day.in_cubic)} 立方` : ''
              }`}
            >
              <span className={day.in_cubic > 0 ? 'arrival-flag is-on' : 'arrival-flag'} />
              <div className="trend-bars">
                <span className="trend-bar is-out" style={{ height: barHeight(day.out_cubic) }} />
              </div>
            </div>
          ))}
        </div>

        <div className="trend-foot">
          <span>{trend[0]?.date ?? ''}</span>
          <span className="trend-range">近 {days} 天（立方）</span>
          <span>{trend[trend.length - 1]?.date ?? ''}</span>
        </div>

        {!loading && trend.length === 0 && <EmptyState text="暂无出货记录" />}
      </div>

      <div className="card">
        <div className="card-head">
          <h2 className="section-title">库存构成</h2>
          <div className="segmented is-sm" role="tablist" aria-label="构成维度">
            {DIMENSIONS.map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={dimension === item.key}
                className={
                  dimension === item.key ? 'segmented-item is-on' : 'segmented-item'
                }
                onClick={() => setDimension(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {composition.length > 0 ? (
          <>
            <div className="stack-bar">
              {composition.map((item, index) => (
                <span
                  key={item.label}
                  className="stack-seg"
                  style={{
                    width: `${item.share}%`,
                    backgroundColor: PALETTE[index % PALETTE.length],
                  }}
                  title={`${item.label}　${formatCubic(item.cubic)} 立方（${item.share}%）`}
                />
              ))}
            </div>

            <ul className="stack-legend">
              {composition.map((item, index) => (
                <li key={item.label}>
                  <i
                    className="stack-dot"
                    style={{ backgroundColor: PALETTE[index % PALETTE.length] }}
                  />
                  <span className="stack-name">{item.label}</span>
                  <span className="stack-cubic">{formatCubic(item.cubic)} 立方</span>
                  <span className="stack-share">{item.share}%</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          !loading && <EmptyState text="当前没有库存" />
        )}

        {loading && <Loading />}
      </div>

      <div className="card">
        <h2 className="section-title">最近 10 条流水</h2>

        <table className="table">
          <thead>
            <tr>
              <th>时间</th>
              <th>类型</th>
              <th>单号</th>
              <th>供应商/客户</th>
              <th className="num">立方</th>
              <th className="num">金额</th>
              <th className="num">明细数</th>
            </tr>
          </thead>
          <tbody>
            {records.map((record) => (
              <tr key={`${record.type}-${record.order_no}`}>
                <td>{record.created_at}</td>
                <td>
                  <span className={record.type === 'in' ? 'tag tag-in' : 'tag tag-out'}>
                    {typeLabel(record.type)}
                  </span>
                </td>
                <td>{record.order_no}</td>
                <td>{record.partner}</td>
                <td className="num">{formatCubic(record.total_cubic)}</td>
                <td className="num amount">{formatMoney(record.total_amount)}</td>
                <td className="num">{record.item_count}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {!loading && records.length === 0 && <EmptyState text="暂无记录" />}
      </div>
    </section>
  )
}
