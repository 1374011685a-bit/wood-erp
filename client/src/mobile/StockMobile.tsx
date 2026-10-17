/** 库存（手机版）：按品名搜索 + 规格卡片 */
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { fetchStockList, type StockRow } from '../api'
import { formatCubic, formatAmount } from '../utils/num'
import { seesMoney } from '../permissions'
import { useRole } from '../hooks/useRole'
import { readListCache, writeListCache } from '../utils/listCache'
import {
  MobileCard,
  MobileEmpty,
  MobileRefreshBar,
  MobileSearchBar,
  MobileSkeleton,
  MobileToastHost,
  useAutoDismiss,
  useCountUp,
  type MobileToastItem,
} from './components'
import { useMobileScrollMemory } from './useMobileScrollMemory'

function StockCard({ row, showMoney }: { row: StockRow; showMoney: boolean }) {
  const cubic = useCountUp(row.total_cubic)
  return (
    <MobileCard key={`${row.species}-${row.thickness}-${row.width}-${row.length}`}>
      <div className="m-page-head" style={{ marginBottom: 8 }}>
        <span className="m-page-title" style={{ fontSize: 'var(--t-17)' }}>
          {row.species}
          <span className="m-unit">等级 {row.grade || '—'}</span>
        </span>
        <span className="m-badge is-ok">{row.total_bundles} 件</span>
      </div>
      <div className="m-rows">
        <div className="m-row">
          <span className="m-row-label">规格</span>
          <span className="m-row-value">
            {row.thickness}×{row.width}×{row.length}
          </span>
        </div>
        <div className="m-row">
          <span className="m-row-label">在库立方</span>
          <span className="m-row-value is-num">
            {formatCubic(cubic)} m³
          </span>
        </div>
        <div className="m-row">
          <span className="m-row-label">片数</span>
          <span className="m-row-value is-num">{row.total_pieces} 片</span>
        </div>
        {showMoney ? (
          <div className="m-row">
            <span className="m-row-label">库存均价</span>
            <span className="m-row-value is-num">
              {row.avg_unit_price === null ? '—' : `${formatAmount(row.avg_unit_price)} 元/m³`}
            </span>
          </div>
        ) : null}
      </div>
    </MobileCard>
  )
}

export default function StockMobile() {
  const location = useLocation()
  const showMoney = seesMoney(useRole())
  const initialCache = readListCache<StockRow[]>('m:stock:')
  const [keyword, setKeyword] = useState('')
  const [rows, setRows] = useState<StockRow[]>(initialCache ?? [])
  const [loading, setLoading] = useState(!initialCache)
  const [refreshing, setRefreshing] = useState(Boolean(initialCache))
  const [toast, setToast] = useState<MobileToastItem | null>(null)
  useAutoDismiss(toast, () => setToast(null))
  useMobileScrollMemory(`${location.pathname}${location.search}`, !loading)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const cacheKey = `m:stock:${keyword.trim()}`
      const cached = readListCache<StockRow[]>(cacheKey)
      if (cached) {
        setRows(cached)
        setLoading(false)
        setRefreshing(true)
      } else {
        setLoading(true)
      }
      void fetchStockList(keyword.trim())
        .then((next) => {
          setRows(next)
          writeListCache(cacheKey, next)
        })
        .catch((err: unknown) =>
          setToast({ id: `e-${Date.now()}`, message: err instanceof Error ? err.message : '加载失败' }),
        )
        .finally(() => {
          setLoading(false)
          setRefreshing(false)
        })
    }, 300)
    return () => window.clearTimeout(timer)
  }, [keyword])

  return (
    <div className="m-stack">
      <MobileSearchBar value={keyword} placeholder="搜品名" onChange={setKeyword} />
      <MobileRefreshBar active={refreshing} />
      {loading ? (
        <MobileSkeleton cards={3} />
      ) : rows.length === 0 ? (
        <MobileEmpty text={keyword ? '没有匹配的库存' : '当前没有库存'} />
      ) : (
        rows.map((row) => (
          <StockCard
            key={`${row.species}-${row.thickness}-${row.width}-${row.length}`}
            row={row}
            showMoney={showMoney}
          />
        ))
      )}
      <MobileToastHost items={[toast]} />
    </div>
  )
}
