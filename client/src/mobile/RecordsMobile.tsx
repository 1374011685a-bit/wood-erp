/** 流水（手机版）：一屏一屏往下翻的出入库明细 */
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { fetchRecords, type RecordRow } from '../api'
import { formatCubic } from '../utils/num'
import { readListCache, writeListCache } from '../utils/listCache'
import {
  MobileEmpty,
  MobileList,
  MobileListItem,
  MobileRefreshBar,
  MobileSegmented,
  MobileSkeleton,
} from './components'
import { useMobileScrollMemory } from './useMobileScrollMemory'

const PAGE_SIZE = 20

export default function RecordsMobile() {
  const location = useLocation()
  const initialCache = readListCache<{ rows: RecordRow[]; total: number }>('m:records:all')
  const [side, setSide] = useState<'all' | 'in' | 'out'>('all')
  const [rows, setRows] = useState<RecordRow[]>(initialCache?.rows ?? [])
  const [total, setTotal] = useState(initialCache?.total ?? 0)
  const [loading, setLoading] = useState(!initialCache)
  const [refreshing, setRefreshing] = useState(Boolean(initialCache))
  useMobileScrollMemory(`${location.pathname}:${side}`, !loading)

  useEffect(() => {
    let alive = true
    const cacheKey = `m:records:${side}`
    const cached = readListCache<{ rows: RecordRow[]; total: number }>(cacheKey)
    if (cached) {
      setRows(cached.rows)
      setTotal(cached.total)
      setLoading(false)
      setRefreshing(true)
    } else {
      setLoading(true)
    }
    void fetchRecords({
      limit: PAGE_SIZE,
      offset: 0,
      ...(side === 'in' ? { type: 'in' as const } : {}),
      ...(side === 'out' ? { type: 'out' as const } : {}),
    })
      .then((result) => {
        if (!alive) return
        setRows(result.records)
        setTotal(result.total)
        writeListCache(cacheKey, { rows: result.records, total: result.total })
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
  }, [side])

  return (
    <div className="m-stack">
      <MobileSegmented
        value={side}
        onChange={setSide}
        options={[
          { value: 'all', label: '全部' },
          { value: 'in', label: '入库' },
          { value: 'out', label: '出库' },
        ]}
      />
      <MobileRefreshBar active={refreshing} />
      {loading ? (
        <MobileSkeleton cards={3} />
      ) : rows.length === 0 ? (
        <MobileEmpty text="还没有流水" />
      ) : (
        <>
          <MobileList>
            {rows.map((row) => (
              <MobileListItem
                key={row.record_id}
                dense
                title={`${row.order_type === 'in' ? '入库' : '出库'} · ${row.species}`}
                sub={`${row.order_no} · ${row.partner || '—'} · ${formatCubic(row.cubic)} m³`}
                trail={row.order_date?.slice(5) ?? ''}
              />
            ))}
          </MobileList>
          <p style={{ textAlign: 'center', color: 'var(--ink-3)', fontSize: 'var(--t-13)' }}>
            共 {total} 条，下拉可继续看
          </p>
        </>
      )}
    </div>
  )
}
