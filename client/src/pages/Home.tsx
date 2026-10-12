import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchHomeSummary, type HomeSummary } from '../api'
import { EmptyState, Loading, PageHead, ToastHost } from '../components/Ui'

const roundTo = (value: number, digits: number) => Number(value.toFixed(digits))
// 立方去掉末尾零（12.996），金额固定两位并带千分位（70,131.60）
const formatCubic = (value: number) => String(roundTo(value, 4))
const formatMoney = (value: number) =>
  value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const formatInt = (value: number) => value.toLocaleString('zh-CN')

const typeLabel = (type: 'in' | 'out') => (type === 'in' ? '入库' : '出库')

/** 库存构成的配色：苹果系统色，克制不刺眼 */
const PALETTE = ['#0a84ff', '#30d158', '#ff9f0a', '#5e5ce6', '#40c8e0', '#8e8e93', '#bf5af2']

export default function Home() {
  const navigate = useNavigate()
  const [summary, setSummary] = useState<HomeSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setSummary(await fetchHomeSummary())
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const records = summary?.recent_records ?? []
  const trend = summary?.trend ?? []
  const composition = summary?.composition ?? []

  // 柱状图的高度基准：两张图共用同一比例
  const trendMax = Math.max(
    0.0001,
    ...trend.map((day) => Math.max(day.in_cubic, day.out_cubic)),
  )
  const barHeight = (value: number) =>
    value <= 0 ? '2px' : `${Math.max(4, (value / trendMax) * 100)}%`

  const delta = summary?.stock_delta_cubic ?? 0
  const deltaUp = delta > 0
  const deltaDown = delta < 0

  return (
    <section>
      <PageHead
        title="首页"
        subtitle="库存、应收应付与最近流水的整体概览"
        extra={
          <>
            <button className="btn btn-sm" onClick={() => navigate('/inbound')}>
              新增入库
            </button>
            <button className="btn btn-sm" onClick={() => navigate('/outbound')}>
              新增出库
            </button>
            <button className="btn btn-sm" onClick={() => navigate('/count')}>
              新增盘点
            </button>
            <button className="btn" onClick={() => void load()} disabled={loading}>
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
        {/* 主视觉：库存盘子 + 近 14 天进出 */}
        <div className="dash-hero">
          <div className="hero-head">
            <span className="hero-label">库存总金额</span>
            {summary && (
              <span
                className={
                  deltaUp
                    ? 'hero-delta is-up'
                    : deltaDown
                      ? 'hero-delta is-down'
                      : 'hero-delta'
                }
              >
                较昨日 {deltaUp ? '+' : ''}
                {formatCubic(delta)} 立方
              </span>
            )}
          </div>

          <div className="hero-value">
            {summary ? formatMoney(summary.total_stock_amount) : '—'}
            <span className="hero-unit">元</span>
          </div>

          <div className="hero-meta">
            <span>
              当前库存 <b>{summary ? formatCubic(summary.total_stock_cubic) : '—'}</b> 立方
            </span>
            <span className="hero-sep" />
            <span>
              共 <b>{summary ? formatInt(summary.total_stock_bundles) : '—'}</b> 件
            </span>
          </div>

          <div className="trend">
            {trend.map((day) => (
              <div
                className="trend-day"
                key={day.date}
                title={`${day.date}\n入库 ${formatCubic(day.in_cubic)} 立方\n出库 ${formatCubic(day.out_cubic)} 立方`}
              >
                <div className="trend-bars">
                  <span className="trend-bar is-in" style={{ height: barHeight(day.in_cubic) }} />
                  <span
                    className="trend-bar is-out"
                    style={{ height: barHeight(day.out_cubic) }}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="trend-foot">
            <span className="trend-key">
              <i className="trend-dot is-in" />
              入库
            </span>
            <span className="trend-key">
              <i className="trend-dot is-out" />
              出库
            </span>
            <span className="trend-range">近 14 天（立方）</span>
          </div>
        </div>

        {/* 侧栏：应收应付 + 今日进出 */}
        <div className="dash-side">
          <button
            type="button"
            className="mini-card"
            onClick={() => navigate('/settlement')}
          >
            <span className="mini-label">应收合计</span>
            <span className="mini-value">
              {summary ? formatMoney(summary.receivable_total) : '—'}
            </span>
            <span className="mini-hint">客户欠款 · 去对账 ›</span>
          </button>

          <button
            type="button"
            className="mini-card"
            onClick={() => navigate('/settlement')}
          >
            <span className="mini-label">应付合计</span>
            <span className="mini-value">
              {summary ? formatMoney(summary.payable_total) : '—'}
            </span>
            <span className="mini-hint">欠供应商 · 去对账 ›</span>
          </button>

          <div className="mini-card is-static">
            <span className="mini-label">今日入库</span>
            <span className="mini-value">
              {summary ? formatCubic(summary.today_in_cubic) : '—'}
              <small>立方</small>
            </span>
            <span className="mini-hint">
              金额 {summary ? formatMoney(summary.today_in_amount) : '—'} 元
            </span>
          </div>

          <div className="mini-card is-static">
            <span className="mini-label">今日出库</span>
            <span className="mini-value">
              {summary ? formatCubic(summary.today_out_cubic) : '—'}
              <small>立方</small>
            </span>
            <span className="mini-hint">
              金额 {summary ? formatMoney(summary.today_out_amount) : '—'} 元
            </span>
          </div>
        </div>
      </div>

      <div className="card">
        <h2 className="section-title">库存构成</h2>

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
