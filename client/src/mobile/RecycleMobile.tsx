import { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
  fetchRecycleList,
  purgeRecycleOrder,
  restoreRecycleOrder,
  type RecycleRow,
} from '../api'
import { seesMoney } from '../permissions'
import { useRole } from '../hooks/useRole'
import { formatAmount, formatCubic } from '../utils/num'
import { readListCache, writeListCache } from '../utils/listCache'
import { tapHeavy, tapLight } from '../utils/haptics'
import {
  MobileChip,
  MobileEmpty,
  MobileIcon,
  MobileList,
  MobileListItem,
  MobileModal,
  MobileSheet,
  MobileSkeleton,
  MobileRefreshBar,
  MobileToastHost,
  MobileTopbarActions,
  MobileTopbarButton,
  useAutoDismiss,
  type MobileToastItem,
} from './components'
import { useMobileScrollMemory } from './useMobileScrollMemory'

const typeLabel = (type: RecycleRow['type']) =>
  type === 'in' ? '入库' : type === 'out' ? '出库' : '合同'

const orderWord = (type: RecycleRow['type']) =>
  type === 'in' ? '入库单' : type === 'out' ? '出库单' : '合同'

export default function RecycleMobile() {
  const location = useLocation()
  const money = seesMoney(useRole())
  const initialCache = readListCache<RecycleRow[]>('m:recycle:list')
  const [rows, setRows] = useState<RecycleRow[]>(initialCache ?? [])
  const [loading, setLoading] = useState(!initialCache)
  const [refreshing, setRefreshing] = useState(Boolean(initialCache))
  const [type, setType] = useState<'' | RecycleRow['type']>('')
  const [detail, setDetail] = useState<RecycleRow | null>(null)
  const [purgeTarget, setPurgeTarget] = useState<RecycleRow | null>(null)
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState<MobileToastItem | null>(null)
  useAutoDismiss(toast, () => setToast(null))
  useMobileScrollMemory(`${location.pathname}${location.search}`, !loading)

  const load = useCallback(async () => {
    const cached = readListCache<RecycleRow[]>('m:recycle:list')
    if (cached) {
      setRows(cached)
      setLoading(false)
      setRefreshing(true)
    } else {
      setLoading(true)
    }
    try {
      const next = await fetchRecycleList()
      setRows(next)
      writeListCache('m:recycle:list', next)
    } catch (err) {
      setToast({
        id: `l-${Date.now()}`,
        message: err instanceof Error ? err.message : '加载回收站失败',
      })
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const filtered = type ? rows.filter((row) => row.type === type) : rows

  const restore = async (row: RecycleRow) => {
    setBusy(`${row.type}-${row.id}`)
    try {
      await restoreRecycleOrder(row.type, row.id)
      setDetail(null)
      await load()
      setToast({
        id: `r-${Date.now()}`,
        message: `已恢复${orderWord(row.type)} ${row.order_no}`,
      })
    } catch (err) {
      setToast({
        id: `r-${Date.now()}`,
        message: err instanceof Error ? err.message : '恢复失败',
      })
    } finally {
      setBusy('')
    }
  }

  const purge = async () => {
    if (!purgeTarget) return
    setBusy(`${purgeTarget.type}-${purgeTarget.id}`)
    try {
      await purgeRecycleOrder(purgeTarget.type, purgeTarget.id)
      setPurgeTarget(null)
      setDetail(null)
      await load()
      setToast({ id: `p-${Date.now()}`, message: '已彻底删除，无法恢复' })
    } catch (err) {
      setToast({
        id: `p-${Date.now()}`,
        message: err instanceof Error ? err.message : '删除失败',
      })
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="m-stack">
      <MobileTopbarActions>
        <MobileTopbarButton
          label="刷新"
          onClick={() => {
            tapLight()
            void load()
          }}
        />
      </MobileTopbarActions>
      <MobileRefreshBar active={refreshing} />

      <div className="m-chip-row">
        {[
          ['', '全部'],
          ['in', '入库'],
          ['out', '出库'],
          ['contract', '合同'],
        ].map(([value, label]) => (
          <MobileChip
            key={value}
            label={label}
            active={type === value}
            onClick={() => setType(value as typeof type)}
          />
        ))}
      </div>

      {loading ? (
        <MobileSkeleton cards={3} />
      ) : filtered.length === 0 ? (
        <MobileEmpty text={type ? `没有删除的${typeLabel(type as RecycleRow['type'])}单` : '回收站是空的'} />
      ) : (
        <MobileList>
          {filtered.map((row) => (
            <MobileListItem
              key={`${row.type}-${row.id}`}
              dense
              title={row.order_no}
              sub={`${row.partner || '—'} · ${row.deleted_at}`}
              icon={<MobileIcon name={row.type === 'contract' ? 'doc' : 'trash'} size={20} />}
              trail={typeLabel(row.type)}
              onClick={() => {
                tapLight()
                setDetail(row)
              }}
            />
          ))}
        </MobileList>
      )}

      <MobileSheet
        open={Boolean(detail)}
        title={detail ? `${typeLabel(detail.type)} ${detail.order_no}` : '回收站'}
        onClose={() => setDetail(null)}
      >
        {detail ? (
          <>
            <div className="m-rows">
              {[
                ['类型', typeLabel(detail.type)],
                ['往来单位', detail.partner || '—'],
                ['单据日期', detail.order_date || '—'],
                ['删除时间', detail.deleted_at],
                ['立方', `${formatCubic(detail.total_cubic)} m³`, true],
                ...(money ? [['金额', `${formatAmount(detail.total_amount)} 元`, true]] : []),
                ['明细数', String(detail.item_count)],
              ].map(([label, value, numeric]) => (
                <div className="m-row" key={String(label)}>
                  <span className="m-row-label">{String(label)}</span>
                  <span className={numeric ? 'm-row-value is-num' : 'm-row-value'}>
                    {String(value)}
                  </span>
                </div>
              ))}
            </div>
            <div className="m-sheet-actions">
              <button
                type="button"
                className="m-btn m-btn-primary"
                disabled={busy !== ''}
                onClick={() => void restore(detail)}
              >
                {busy === `${detail.type}-${detail.id}` ? '处理中…' : '恢复'}
              </button>
              <button
                type="button"
                className="m-btn m-btn-danger"
                onClick={() => {
                  tapHeavy()
                  setPurgeTarget(detail)
                }}
              >
                彻底删除
              </button>
            </div>
          </>
        ) : null}
      </MobileSheet>

      <MobileModal
        open={Boolean(purgeTarget)}
        title="彻底删除？"
        message={
          purgeTarget
            ? `${purgeTarget.order_no} 会连同明细一起物理删除，此操作不可恢复。`
            : undefined
        }
        confirmLabel={busy ? '处理中…' : '彻底删除'}
        danger
        onConfirm={() => void purge()}
        onClose={() => {
          if (!busy) setPurgeTarget(null)
        }}
      />

      <MobileToastHost items={[toast]} />
    </div>
  )
}
