import { useCallback, useEffect, useState } from 'react'
import { fetchHomeSummary, type HomeSummary } from '../api'
import {
  EmptyState,
  Loading,
  PageHead,
  StatCard,
  ToastHost,
} from '../components/Ui'

const roundTo = (value: number, digits: number) => Number(value.toFixed(digits))

// 立方去掉末尾零（12.996），金额固定两位（28728.00）
const formatCubic = (value: number) => String(roundTo(value, 4))
const formatAmount = (value: number) => value.toFixed(2)

const typeLabel = (type: 'in' | 'out') => (type === 'in' ? '入库' : '出库')


export default function Home() {
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

  return (
    <section>
      <PageHead
        title="首页"
        subtitle="库存、今日出入库与最近流水的整体概览"
        extra={
          <button className="btn" onClick={() => void load()}>
            刷新
          </button>
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

      <div className="stat-grid">
        <StatCard
          label="当前总库存"
          value={summary ? formatCubic(summary.total_stock_cubic) : '—'}
          unit="立方"
          tone="blue"
        />
        <StatCard
          label="当前总件数"
          value={summary ? String(summary.total_stock_bundles) : '—'}
          unit="件"
          tone="blue"
        />
        <StatCard
          label="库存总金额"
          value={summary ? formatAmount(summary.total_stock_amount) : '—'}
          unit="元"
          sub="按各规格最近入库单价估算"
          tone="orange"
        />
        <StatCard
          label="今日入库"
          value={summary ? formatCubic(summary.today_in_cubic) : '—'}
          unit="立方"
          sub={`金额 ${summary ? formatAmount(summary.today_in_amount) : '—'} 元`}
          tone="green"
        />
        <StatCard
          label="今日出库"
          value={summary ? formatCubic(summary.today_out_cubic) : '—'}
          unit="立方"
          sub={`金额 ${summary ? formatAmount(summary.today_out_amount) : '—'} 元`}
          tone="red"
        />
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
                  <span
                    className={record.type === 'in' ? 'tag tag-in' : 'tag tag-out'}
                  >
                    {typeLabel(record.type)}
                  </span>
                </td>
                <td>{record.order_no}</td>
                <td>{record.partner}</td>
                <td className="num">{formatCubic(record.total_cubic)}</td>
                <td className="num amount">{formatAmount(record.total_amount)}</td>
                <td className="num">{record.item_count}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {!loading && records.length === 0 && <EmptyState text="暂无记录" />}
        {loading && <Loading />}
      </div>
    </section>
  )
}
