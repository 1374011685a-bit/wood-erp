/**
 * 手机端首页（第 2 刀 · 白名单里的第一个页面）。
 *
 * 和桌面首页完全不共用渲染：api / hooks 照旧共用，UI 是新的。
 * 结构：横滑数字卡 → 今日任务列表 → 底部快捷入口。
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchHomeSummary, type HomeSummary } from '../api'
import { useRole } from '../hooks/useRole'
import { seesMoney } from '../permissions'
import { formatCubic } from '../utils/num'
import {
  MobileCard,
  MobileEmpty,
  MobileList,
  MobileListItem,
  MobileSkeleton,
  useCountUp,
} from './components'

const money = (v: number) =>
  v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function HomeMobile() {
  const navigate = useNavigate()
  const role = useRole()
  const showMoney = seesMoney(role)
  const [summary, setSummary] = useState<HomeSummary | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    void fetchHomeSummary({ days: 14, dimension: 'spec' })
      .then((data) => alive && setSummary(data))
      .catch(() => undefined)
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  const todayIn = useCountUp(summary?.today_in_cubic ?? 0)
  const todayOut = useCountUp(summary?.today_out_cubic ?? 0)
  const stockCubic = useCountUp(summary?.total_stock_cubic ?? 0)
  const stockBundles = useCountUp(summary?.total_stock_bundles ?? 0)

  const stats = [
    { label: '今日到货', value: formatCubic(todayIn), unit: '立方' },
    { label: '今日出库', value: formatCubic(todayOut), unit: '立方' },
    { label: '在库总量', value: formatCubic(stockCubic), unit: '立方' },
    showMoney
      ? { label: '库存总值', value: money(summary?.total_stock_amount ?? 0), unit: '元' }
      : { label: '待打印标签', value: String(Math.round(stockBundles)), unit: '件' },
  ]

  const tasks = (summary?.recent_records ?? []).slice(0, 6)

  return (
    <div>
      {loading ? (
        <MobileSkeleton cards={2} />
      ) : (
        <>
          <div className="m-scroller">
            {stats.map((item) => (
              <div className="m-stat" key={item.label}>
                <span className="m-stat-label">{item.label}</span>
                <span className="m-num-lg">
                  {item.value}
                  <span className="m-unit">{item.unit}</span>
                </span>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 12 }}>
            <MobileCard title="今日任务">
              {tasks.length === 0 ? (
                <MobileEmpty
                  text="今天还没有单据"
                  actionLabel="去录入库"
                  onAction={() => navigate('/inbound/new')}
                />
              ) : (
                <MobileList>
                  {tasks.map((record, index) => (
                    <MobileListItem
                      key={`${record.order_no}-${index}`}
                      title={record.order_no}
                      sub={`${record.partner || '—'} · ${record.type === 'in' ? '入库' : '出库'} ${formatCubic(record.total_cubic)} 立方`}
                      trail={record.order_date?.slice(5) ?? ''}
                      onClick={() =>
                        navigate(record.type === 'in' ? '/inbound' : '/outbound')
                      }
                    />
                  ))}
                </MobileList>
              )}
            </MobileCard>
          </div>

          <div style={{ marginTop: 12 }}>
            <MobileCard title="快捷入口">
              <MobileList>
                <MobileListItem title="入库" sub="扫单 / 选合同录一张单" onClick={() => navigate('/inbound/new')} />
                <MobileListItem title="出库" sub="扫码出货，库存自动扣减" onClick={() => navigate('/outbound/new')} />
                <MobileListItem title="入库单列表" sub="看历史单据、改单、删单" onClick={() => navigate('/inbound')} />
              </MobileList>
            </MobileCard>
          </div>
        </>
      )}
    </div>
  )
}
