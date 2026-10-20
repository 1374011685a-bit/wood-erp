import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import type {
  HomeCompositionDimension,
  HomeSummary,
} from '../api'
import { formatCubic } from '../utils/num'

const PALETTE = ['#6b4a2f', '#a77c54', '#d2b48c', '#86909c', '#4e5969', '#b8a18a']
const PERIODS: Array<7 | 14 | 30> = [7, 14, 30]
const DIMENSIONS: Array<{ key: HomeCompositionDimension; label: string }> = [
  { key: 'spec', label: '规格' },
  { key: 'species', label: '品名' },
  { key: 'grade', label: '等级' },
]

const formatMoney = (value: number) =>
  value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const formatInt = (value: number) => Math.round(value).toLocaleString('zh-CN')

export type CommerceQuickAction = {
  to: string
  label: string
  icon: ReactNode
}

function PercentHint({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) {
    return <span className="wb-kpi-trend is-flat">暂无对比</span>
  }
  return (
    <span className={`wb-kpi-trend ${value >= 0 ? 'is-up' : 'is-down'}`}>
      较上期 {value >= 0 ? '↑' : '↓'} {Math.abs(value)}%
    </span>
  )
}

export default function CommerceWorkbench({
  summary,
  loading,
  money,
  days,
  onDaysChange,
  dimension,
  onDimensionChange,
  quickActions,
}: {
  summary: HomeSummary | null
  loading: boolean
  money: boolean
  days: 7 | 14 | 30
  onDaysChange: (value: 7 | 14 | 30) => void
  dimension: HomeCompositionDimension
  onDimensionChange: (value: HomeCompositionDimension) => void
  quickActions: CommerceQuickAction[]
}) {
  const navigate = useNavigate()
  const [chartMode, setChartMode] = useState<'trend' | 'composition'>('trend')
  const trend = summary?.trend ?? []
  const composition = summary?.composition ?? []
  const records = (summary?.recent_records ?? []).slice(0, 5)
  const trendMax = Math.max(0.0001, ...trend.map((day) => day.out_cubic))
  const hasTrendData = trend.some((day) => day.out_cubic > 0)
  const barHeight = (value: number) =>
    value <= 0 ? '2px' : `${Math.max(4, (value / trendMax) * 100)}%`

  const kpis = [
    {
      label: '今日入库',
      value: summary ? formatCubic(summary.today_in_cubic) : '—',
      unit: 'm³',
      detail: money && summary ? `¥ ${formatMoney(summary.today_in_amount)}` : '今日累计',
      trend: summary?.compare.in.mom_percent,
    },
    {
      label: '今日出库',
      value: summary ? formatCubic(summary.today_out_cubic) : '—',
      unit: 'm³',
      detail: money && summary ? `¥ ${formatMoney(summary.today_out_amount)}` : '今日累计',
      trend: summary?.compare.out.mom_percent,
    },
    {
      label: '库存总方数',
      value: summary ? formatCubic(summary.total_stock_cubic) : '—',
      unit: 'm³',
      detail: summary ? `${formatInt(summary.total_stock_bundles)} 件` : '实时库存',
      trend: summary?.stock_delta_percent,
    },
    {
      label: money ? '库存总金额' : '库存件数',
      value: summary
        ? money
          ? formatMoney(summary.total_stock_amount)
          : formatInt(summary.total_stock_bundles)
        : '—',
      unit: money ? '元' : '件',
      detail: '当前库存',
      trend: summary?.stock_delta_percent,
    },
  ]

  const reminders = [
    {
      label: '库存状态',
      text:
        summary?.days_of_supply == null
          ? '暂无可售天数数据'
          : `预计可售 ${summary.days_of_supply} 天`,
      tone:
        summary?.days_of_supply != null && summary.days_of_supply < 7
          ? 'warning'
          : 'success',
      tag:
        summary?.days_of_supply != null && summary.days_of_supply < 7
          ? '库存预警'
          : '正常',
    },
    {
      label: '最近单据',
      text: `${summary?.recent_records.length ?? 0} 条动态待查看`,
      tone: 'info',
      tag: '待查看',
    },
    {
      label: '系统公告',
      text: '经营数据已同步至最新状态',
      tone: 'neutral',
      tag: '已同步',
    },
  ]

  return (
    <div className="commerce-workbench">
      <section className="wb-kpi-card">
        {kpis.map((item) => (
          <div className="wb-kpi" key={item.label}>
            <span className="wb-kpi-label">{item.label}</span>
            <div className="wb-kpi-value">
              {item.value}
              <small>{item.unit}</small>
            </div>
            <div className="wb-kpi-foot">
              <span>{item.detail}</span>
              <PercentHint value={item.trend} />
            </div>
          </div>
        ))}
      </section>

      <div className="wb-main-grid">
        <section className="wb-panel wb-chart-panel">
          <div className="wb-panel-head">
            <div>
              <h2>经营趋势</h2>
              <p>
                {chartMode === 'trend'
                  ? `近 ${days} 天出库表现`
                  : '当前库存结构占比'}
              </p>
            </div>
            <div className="wb-head-actions">
              <div className="wb-segment" role="tablist" aria-label="图表类型">
                <button
                  type="button"
                  className={chartMode === 'trend' ? 'is-active' : ''}
                  onClick={() => setChartMode('trend')}
                >
                  出库趋势
                </button>
                <button
                  type="button"
                  className={chartMode === 'composition' ? 'is-active' : ''}
                  onClick={() => setChartMode('composition')}
                >
                  库存构成
                </button>
              </div>
              {chartMode === 'trend' ? (
                <div className="wb-segment" role="tablist" aria-label="趋势周期">
                  {PERIODS.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={days === value ? 'is-active' : ''}
                      onClick={() => onDaysChange(value)}
                    >
                      {value}天
                    </button>
                  ))}
                </div>
              ) : (
                <div className="wb-segment" role="tablist" aria-label="构成维度">
                  {DIMENSIONS.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      className={dimension === item.key ? 'is-active' : ''}
                      onClick={() => onDimensionChange(item.key)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {chartMode === 'trend' ? (
            <div className="wb-trend">
              {!loading && !hasTrendData ? (
                <div className="wb-chart-empty">暂无出库数据</div>
              ) : (
                <>
                  <div className="wb-trend-grid" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                    <i />
                  </div>
                  <div className="wb-bars">
                    {trend.map((day) => (
                      <div
                        className="wb-bar-column"
                        key={day.date}
                        title={`${day.date} · 出库 ${formatCubic(day.out_cubic)} m³`}
                      >
                        {day.in_cubic > 0 ? <span className="wb-arrival-dot" /> : null}
                        <span
                          className="wb-bar"
                          style={{ height: barHeight(day.out_cubic) }}
                        />
                        <small>{day.date.slice(5)}</small>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="wb-composition">
              <div className="wb-stack">
                {composition.map((item, index) => (
                  <span
                    key={item.label}
                    style={{
                      width: `${item.share}%`,
                      background: PALETTE[index % PALETTE.length],
                    }}
                    title={`${item.label} ${formatCubic(item.cubic)} m³`}
                  />
                ))}
              </div>
              <div className="wb-stack-list">
                {composition.slice(0, 6).map((item, index) => (
                  <div key={item.label}>
                    <i style={{ background: PALETTE[index % PALETTE.length] }} />
                    <span>{item.label}</span>
                    <b>{formatCubic(item.cubic)} m³</b>
                    <small>{item.share}%</small>
                  </div>
                ))}
              </div>
              {!loading && composition.length === 0 ? (
                <div className="wb-chart-empty">暂无库存数据</div>
              ) : null}
            </div>
          )}
        </section>

        <aside className="wb-side">
          <section className="wb-panel">
            <div className="wb-panel-head">
              <div>
                <h2>快捷操作</h2>
                <p>常用业务入口</p>
              </div>
            </div>
            <div className="wb-quick-grid">
              {quickActions.slice(0, 6).map((action) => (
                <button
                  key={`${action.to}-${action.label}`}
                  type="button"
                  onClick={() => navigate(action.to)}
                >
                  <span>{action.icon}</span>
                  <b>{action.label}</b>
                </button>
              ))}
            </div>
          </section>

          <section className="wb-panel">
            <div className="wb-panel-head">
              <div>
                <h2>待办事项</h2>
                <p>需要重点关注</p>
              </div>
            </div>
            <div className="wb-reminders">
              {reminders.map((item) => (
                <div key={item.label}>
                  <i className={`is-${item.tone}`} />
                  <span>
                    <b>{item.label}</b>
                    <small>{item.text}</small>
                  </span>
                  <em>{item.tag}</em>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>

      <section className="wb-panel wb-activity">
        <div className="wb-panel-head">
          <div>
            <h2>最近动态</h2>
            <p>最近 5 条入库 / 出库记录</p>
          </div>
          <button type="button" className="wb-text-action" onClick={() => navigate('/records')}>
            查看全部
          </button>
        </div>
        <div className="wb-activity-table">
          <div
            className={`wb-activity-row wb-activity-head ${money ? 'has-money' : 'is-compact'}`}
          >
            <span>时间</span>
            <span>类型</span>
            <span>单号</span>
            <span>客户 / 供应商</span>
            {money ? <span>金额</span> : null}
          </div>
          {records.map((record) => (
            <div
              className={`wb-activity-row ${money ? 'has-money' : 'is-compact'}`}
              key={`${record.type}-${record.order_no}`}
            >
              <span>{record.created_at.replace('T', ' ').slice(5, 16)}</span>
              <span>
                <i className={record.type === 'in' ? 'is-in' : 'is-out'} />
                {record.type === 'in' ? '入库' : '出库'}
              </span>
              <span>{record.order_no}</span>
              <span>{record.partner || '—'}</span>
              {money ? <span>¥ {formatMoney(record.total_amount)}</span> : null}
            </div>
          ))}
          {!loading && records.length === 0 ? (
            <div className="wb-activity-empty">暂无最近动态</div>
          ) : null}
        </div>
      </section>
    </div>
  )
}
