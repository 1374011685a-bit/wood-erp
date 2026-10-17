import { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
  fetchBales,
  fetchContractPicker,
  fetchShipments,
  type BaleRow,
  type ContractPickerRow,
  type ShipmentRow,
} from '../api'
import { formatCubic } from '../utils/num'
import { contractStage } from '../utils/contractStatus'
import { readListCache, writeListCache } from '../utils/listCache'
import { tapLight, tapMedium } from '../utils/haptics'
import {
  MobileBadge,
  MobileChip,
  MobileEmpty,
  MobileList,
  MobileListItem,
  MobileSearchBar,
  MobileSegmented,
  MobileSheet,
  MobileSkeleton,
  MobileRefreshBar,
  MobileStatusTag,
  MobileToastHost,
  MobileTopbarActions,
  MobileTopbarButton,
  useAutoDismiss,
  type MobileToastItem,
} from './components'
import { useMobileNavigate } from './useMobileNavigate'
import { useMobileScrollMemory } from './useMobileScrollMemory'

const PAGE_SIZE = 50

type View = 'bales' | 'contracts' | 'shipments'

const statusText = (status: BaleRow['status']) => (status === 'in_stock' ? '在库' : '已出库')

export default function BalesMobile() {
  const navigate = useMobileNavigate()
  const location = useLocation()
  const [view, setView] = useState<View>('bales')
  const [contract, setContract] = useState<{ no: string; title: string } | null>(null)
  const [shipment, setShipment] = useState<ShipmentRow | null>(null)
  const [keyword, setKeyword] = useState('')
  const [debounced, setDebounced] = useState('')
  const [status, setStatus] = useState<'' | 'in_stock' | 'shipped'>('')
  const defaultBalesKey = `m:bales:${JSON.stringify({
    keyword: '',
    status: '',
    contract: '',
    shipment: 0,
  })}`
  const initialCache = readListCache<{
    rows: BaleRow[]
    total: number
    totalInStock: number
    cubicInStock: number
  }>(defaultBalesKey)
  const [rows, setRows] = useState<BaleRow[]>(initialCache?.rows ?? [])
  const [total, setTotal] = useState(initialCache?.total ?? 0)
  const [totalInStock, setTotalInStock] = useState(initialCache?.totalInStock ?? 0)
  const [cubicInStock, setCubicInStock] = useState(initialCache?.cubicInStock ?? 0)
  const [loading, setLoading] = useState(!initialCache)
  const [refreshing, setRefreshing] = useState(Boolean(initialCache))
  const [loadingMore, setLoadingMore] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const [contracts, setContracts] = useState<ContractPickerRow[]>([])
  const [contractsLoading, setContractsLoading] = useState(false)
  const [shipments, setShipments] = useState<ShipmentRow[]>([])
  const [shipmentsLoading, setShipmentsLoading] = useState(false)
  const [picked, setPicked] = useState<number[]>([])
  const [detail, setDetail] = useState<BaleRow | null>(null)
  const [toast, setToast] = useState<MobileToastItem | null>(null)
  useAutoDismiss(toast, () => setToast(null))
  useMobileScrollMemory(
    `${location.pathname}:${view}:${contract?.no ?? ''}:${shipment?.id ?? ''}`,
    !loading,
  )

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(keyword.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [keyword])

  const loadBales = useCallback(
    async (offset: number, append: boolean) => {
      const cacheKey = `m:bales:${JSON.stringify({
        keyword: debounced,
        status,
        contract: contract?.no ?? '',
        shipment: shipment?.id ?? 0,
      })}`
      if (append) {
        setLoadingMore(true)
      } else {
        const cached = readListCache<{
          rows: BaleRow[]
          total: number
          totalInStock: number
          cubicInStock: number
        }>(cacheKey)
        if (cached) {
          setRows(cached.rows)
          setTotal(cached.total)
          setTotalInStock(cached.totalInStock)
          setCubicInStock(cached.cubicInStock)
          setLoading(false)
          setRefreshing(true)
        } else {
          setLoading(true)
        }
      }
      try {
        const result = await fetchBales({
          keyword: debounced || undefined,
          status,
          ...(shipment
            ? { shipment_id: shipment.id }
            : contract
              ? { contract_no: contract.no }
              : {}),
          limit: PAGE_SIZE,
          offset,
        })
        setRows((prev) => (append ? [...prev, ...result.rows] : result.rows))
        setTotal(result.total)
        setTotalInStock(result.total_in_stock ?? 0)
        setCubicInStock(result.cubic_in_stock ?? 0)
        if (!append) {
          writeListCache(cacheKey, {
            rows: result.rows,
            total: result.total,
            totalInStock: result.total_in_stock ?? 0,
            cubicInStock: result.cubic_in_stock ?? 0,
          })
        }
      } catch (err) {
        setToast({
          id: `b-${Date.now()}`,
          message: err instanceof Error ? err.message : '加载码单失败',
        })
      } finally {
        setLoading(false)
        setLoadingMore(false)
        setRefreshing(false)
      }
    },
    [debounced, status, shipment, contract],
  )

  useEffect(() => {
    if (view !== 'bales') return
    void loadBales(0, false)
  }, [loadBales, view, reloadToken])

  useEffect(() => {
    setPicked([])
  }, [rows.map((row) => row.id).join(',')])

  useEffect(() => {
    if (view !== 'contracts') return
    let cancelled = false
    setContractsLoading(true)
    fetchContractPicker({ keyword: debounced || undefined, limit: 100 })
      .then((result) => {
        if (!cancelled) setContracts(result.rows)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setToast({
            id: `c-${Date.now()}`,
            message: err instanceof Error ? err.message : '加载合同进度失败',
          })
        }
      })
      .finally(() => {
        if (!cancelled) setContractsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [view, debounced, reloadToken])

  useEffect(() => {
    if (view !== 'shipments' || !contract) return
    let cancelled = false
    setShipmentsLoading(true)
    fetchShipments({ contract_no: contract.no, limit: 100 })
      .then((result) => {
        if (!cancelled) setShipments(result.rows)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setToast({
            id: `s-${Date.now()}`,
            message: err instanceof Error ? err.message : '加载提单失败',
          })
        }
      })
      .finally(() => {
        if (!cancelled) setShipmentsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [view, contract, reloadToken])

  const pageIds = rows.map((row) => row.id)
  const allPicked = pageIds.length > 0 && pageIds.every((id) => picked.includes(id))
  const togglePick = (id: number) => {
    setPicked((prev) => (prev.includes(id) ? prev.filter((one) => one !== id) : [...prev, id]))
  }

  const resetDrill = () => {
    setContract(null)
    setShipment(null)
    setView('bales')
    setKeyword('')
  }

  return (
    <div className="m-stack" style={{ paddingBottom: 64 }}>
      <MobileTopbarActions>
        <MobileTopbarButton
          label="刷新"
          onClick={() => {
            tapLight()
            setReloadToken((value) => value + 1)
          }}
        />
      </MobileTopbarActions>

      <MobileSegmented
        value={view === 'bales' ? 'bales' : 'contracts'}
        options={[
          { value: 'bales', label: '包列表' },
          { value: 'contracts', label: '合同进度' },
        ]}
        onChange={(next) => {
          setView(next)
          if (next === 'contracts') {
            setContract(null)
            setShipment(null)
          }
        }}
      />
      <MobileRefreshBar active={refreshing} />

      {view !== 'contracts' ? (
        <MobileSearchBar
          value={keyword}
          placeholder="包号 / 条码 / 提单号"
          onChange={setKeyword}
        />
      ) : (
        <MobileSearchBar value={keyword} placeholder="合同号 / 名称 / 往来单位" onChange={setKeyword} />
      )}

      {contract || shipment ? (
        <div className="m-breadcrumb">
          <button type="button" onClick={resetDrill}>
            全部
          </button>
          {contract ? (
            <>
              <span>›</span>
              <button
                type="button"
                onClick={() => {
                  setShipment(null)
                  setView('shipments')
                }}
              >
                {contract.no}
              </button>
            </>
          ) : null}
          {shipment ? (
            <>
              <span>›</span>
              <b>{shipment.bl_no}</b>
            </>
          ) : null}
        </div>
      ) : null}

      {view === 'contracts' ? (
        contractsLoading ? (
          <MobileSkeleton cards={3} />
        ) : contracts.length === 0 ? (
          <MobileEmpty text={debounced ? '没有匹配的合同' : '还没有合同'} />
        ) : (
          <MobileList>
            {contracts.map((row) => (
              <MobileListItem
                key={row.id}
                dense
                title={row.contract_no}
                sub={`${row.partner || '—'} · 已入 ${formatCubic(row.in_cubic)} m³ · ${row.status || '—'}`}
                trail={
                  <span className="m-list-trail-stack">
                    <span>还差 {formatCubic(row.left_cubic)}</span>
                    <MobileStatusTag tone={contractStage(row).tone}>
                      {contractStage(row).label}
                    </MobileStatusTag>
                  </span>
                }
                onClick={() => {
                  tapLight()
                  setContract({ no: row.contract_no, title: row.title })
                  setShipment(null)
                  setView('shipments')
                }}
              />
            ))}
          </MobileList>
        )
      ) : view === 'shipments' ? (
        shipmentsLoading ? (
          <MobileSkeleton cards={3} />
        ) : shipments.length === 0 ? (
          <MobileEmpty text="这张合同下还没有提单" />
        ) : (
          <MobileList>
            {shipments.map((row) => (
              <MobileListItem
                key={row.id}
                dense
                title={row.bl_no}
                sub={`原 ${formatCubic(row.original_cubic)} m³ · 现在 ${formatCubic(row.bale_cubic)} m³ · ${row.bale_total} 包`}
                trail={row.bale_in_stock === row.bale_total ? '全部在库' : '部分出库'}
                onClick={() => {
                  tapLight()
                  setShipment(row)
                  setView('bales')
                }}
              />
            ))}
          </MobileList>
        )
      ) : (
        <>
          <div className="m-bales-summary">
            <b>{totalInStock} 包在库</b>
            <span>{formatCubic(cubicInStock)} m³ · 共 {total} 包</span>
          </div>

          <div className="m-chip-row">
            {[
              ['', '全部'],
              ['in_stock', '在库'],
              ['shipped', '已出库'],
            ].map(([value, label]) => (
              <MobileChip
                key={value}
                label={label}
                active={status === value}
                onClick={() => setStatus(value as typeof status)}
              />
            ))}
          </div>

          {loading ? (
            <MobileSkeleton cards={4} />
          ) : rows.length === 0 ? (
            <MobileEmpty text={debounced ? '没有匹配的包' : '当前没有码单'} />
          ) : (
            <>
              <div className="m-bale-list">
                {rows.map((bale) => {
                  const on = picked.includes(bale.id)
                  return (
                    <div
                      className={on ? 'm-bale-row is-on' : 'm-bale-row'}
                      key={bale.id}
                      role="checkbox"
                      aria-checked={on}
                      tabIndex={0}
                      onClick={() => togglePick(bale.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          togglePick(bale.id)
                        }
                      }}
                    >
                      <span className="m-check-box" aria-hidden="true">
                        ✓
                      </span>
                      <span className="m-bale-main">
                        <span className="m-bale-title">
                          <span>{bale.bale_no || bale.barcode}</span>
                          <MobileBadge tone={bale.status === 'in_stock' ? 'ok' : 'warn'}>
                            {statusText(bale.status)}
                          </MobileBadge>
                        </span>
                        <span className="m-bale-sub">
                          提单 {bale.bl_no || '—'} · {bale.species} {bale.grade || ''} ·{' '}
                          {bale.spec_text || `${bale.thickness}×${bale.width}×${bale.length}`}
                        </span>
                        <span className="m-bale-cubic">
                          {formatCubic(bale.cubic)} m³ · {bale.pieces_text || bale.pieces} 片
                        </span>
                      </span>
                      <button
                        type="button"
                        className="m-bale-detail"
                        aria-label="查看这一包详情"
                        onClick={(event) => {
                          event.stopPropagation()
                          tapLight()
                          setDetail(bale)
                        }}
                      >
                        ›
                      </button>
                    </div>
                  )
                })}
              </div>
              {rows.length < total ? (
                <button
                  type="button"
                  className="m-loadmore"
                  disabled={loadingMore}
                  onClick={() => void loadBales(rows.length, true)}
                >
                  {loadingMore ? '加载中…' : `加载更多（还有 ${total - rows.length} 包）`}
                </button>
              ) : (
                <p className="m-list-end">共 {total} 包</p>
              )}
            </>
          )}

          <div className="m-actionbar">
            <button
              type="button"
              className="m-btn m-btn-primary"
              disabled={picked.length === 0}
              onClick={() => {
                tapMedium()
                navigate(`/label/print?ids=${picked.join(',')}`)
              }}
            >
              打印标签（{picked.length}）
            </button>
            <button
              type="button"
              className="m-btn m-btn-ghost"
              onClick={() => {
                tapLight()
                setPicked(allPicked ? [] : pageIds)
              }}
            >
              {allPicked ? '取消全选' : '全选本页'}
            </button>
          </div>
        </>
      )}

      <MobileSheet open={Boolean(detail)} title={detail?.bale_no || detail?.barcode || '码单详情'} onClose={() => setDetail(null)}>
        {detail ? (
          <>
            <div className="m-rows">
              {[
                ['包号', detail.bale_no || '—'],
                ['条码号', detail.barcode || '—'],
                ['提单号', detail.bl_no || '—'],
                ['合同号', detail.contract_no || '—'],
                ['状态', statusText(detail.status)],
                ['品名', `${detail.species} ${detail.grade || ''}`.trim()],
                ['规格', detail.spec_text || `${detail.thickness}×${detail.width}×${detail.length}`],
                ['片数', detail.pieces_text || String(detail.pieces), true],
                ['立方', `${formatCubic(detail.cubic)} m³`, true],
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
                onClick={() => navigate(`/label/print?ids=${detail.id}`)}
              >
                打印标签
              </button>
              <button type="button" className="m-btn m-btn-ghost" onClick={() => setDetail(null)}>
                关闭
              </button>
            </div>
          </>
        ) : null}
      </MobileSheet>

      <MobileToastHost items={[toast]} />
    </div>
  )
}
