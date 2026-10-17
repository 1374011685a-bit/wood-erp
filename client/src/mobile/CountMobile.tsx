import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import {
  createCount,
  deleteCount,
  fetchCountDetail,
  fetchCountList,
  fetchStockList,
  type CountDetail,
  type CountListRow,
  type CountLinePayload,
  type StockRow,
} from '../api'
import { seesMoney } from '../permissions'
import { useRole } from '../hooks/useRole'
import { formatCubic, roundTo, todayLocal } from '../utils/num'
import { readListCache, writeListCache } from '../utils/listCache'
import { tapHeavy, tapLight } from '../utils/haptics'
import { goBack } from './nav'
import {
  MobileCard,
  MobileDatePicker,
  MobileEmpty,
  MobileInput,
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
import { useMobileNavigate } from './useMobileNavigate'
import { useMobileFormKeyboard } from './useMobileFormKeyboard'
import { useMobileScrollMemory } from './useMobileScrollMemory'

type FormRow = {
  key: number
  species: string
  grade: string
  thickness: string
  width: string
  length: string
  pieces: string
  book: number
  actual: string
  unitPrice: string
  manual: boolean
}

let rowSeq = 0

const createManualRow = (): FormRow => ({
  key: (rowSeq += 1),
  species: '',
  grade: '',
  thickness: '',
  width: '',
  length: '',
  pieces: '1',
  book: 0,
  actual: '',
  unitPrice: '',
  manual: true,
})

export default function CountMobile() {
  const navigate = useMobileNavigate()
  const location = useLocation()
  const [params] = useSearchParams()
  const formMode = params.get('mode') === 'new'
  useMobileFormKeyboard(formMode)
  const money = seesMoney(useRole())
  const initialCache = readListCache<CountListRow[]>('m:count:list')
  const [rows, setRows] = useState<CountListRow[]>(initialCache ?? [])
  const [loading, setLoading] = useState(!initialCache)
  const [refreshing, setRefreshing] = useState(Boolean(initialCache))
  const [reloadToken, setReloadToken] = useState(0)
  const [detail, setDetail] = useState<CountDetail | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CountListRow | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [toast, setToast] = useState<MobileToastItem | null>(null)
  useAutoDismiss(toast, () => setToast(null))
  useMobileScrollMemory(`${location.pathname}${location.search}`, !loading)

  const [formRows, setFormRows] = useState<FormRow[]>([])
  const [countDate, setCountDate] = useState(todayLocal())
  const [remark, setRemark] = useState('')
  const [formLoading, setFormLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const cached = readListCache<CountListRow[]>('m:count:list')
    if (cached) {
      setRows(cached)
      setLoading(false)
      setRefreshing(true)
    } else {
      setLoading(true)
    }
    try {
      const next = await fetchCountList()
      setRows(next)
      writeListCache('m:count:list', next)
    } catch (err) {
      setToast({
        id: `l-${Date.now()}`,
        message: err instanceof Error ? err.message : '加载盘点单失败',
      })
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    if (!formMode) void load()
  }, [load, reloadToken, formMode])

  useEffect(() => {
    if (!formMode) return
    setFormLoading(true)
    setCountDate(todayLocal())
    setRemark('')
    fetchStockList('')
      .then((stock: StockRow[]) => {
        setFormRows(
          stock.map((row) => {
            const bundles = row.total_bundles ?? 0
            return {
              key: (rowSeq += 1),
              species: row.species,
              grade: row.grade || '',
              thickness: String(row.thickness),
              width: String(row.width),
              length: String(row.length),
              pieces: String(
                bundles > 0 ? Math.max(1, Math.round((row.total_pieces ?? 0) / bundles)) : 1,
              ),
              book: bundles,
              actual: String(bundles),
              unitPrice:
                row.avg_unit_price === null || row.avg_unit_price === undefined
                  ? ''
                  : String(row.avg_unit_price),
              manual: false,
            }
          }),
        )
      })
      .catch((err: unknown) => {
        setToast({
          id: `s-${Date.now()}`,
          message: err instanceof Error ? err.message : '加载库存失败',
        })
      })
      .finally(() => setFormLoading(false))
  }, [formMode])

  const computed = useMemo(
    () =>
      formRows.map((row) => {
        const actual = Number(row.actual)
        const diff = Number.isFinite(actual) && row.actual.trim() !== '' ? actual - row.book : 0
        const cubic = roundTo(
          (Number(row.thickness) * Number(row.width) * Number(row.length) * Number(row.pieces)) /
            1_000_000,
          4,
        )
        return { key: row.key, diff, cubic: roundTo(diff * cubic, 4) }
      }),
    [formRows],
  )

  const diffTotal = roundTo(computed.reduce((sum, row) => sum + row.cubic, 0), 4)

  const updateRow = (key: number, patch: Partial<FormRow>) => {
    setFormRows((prev) =>
      prev.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    )
  }

  const save = async () => {
    if (formRows.length === 0) {
      setToast({ id: `v-${Date.now()}`, message: '至少需要一行盘点明细' })
      return
    }
    for (const row of formRows) {
      if (
        !row.species.trim() ||
        !(Number(row.thickness) > 0) ||
        !(Number(row.width) > 0) ||
        !(Number(row.length) > 0) ||
        !(Number(row.pieces) > 0) ||
        row.actual.trim() === '' ||
        !Number.isInteger(Number(row.actual)) ||
        Number(row.actual) < 0
      ) {
        setToast({
          id: `v-${Date.now()}`,
          message: `请检查 ${row.species || '手动行'} 的规格和实盘件数`,
        })
        return
      }
    }
    const items: CountLinePayload[] = formRows.map((row) => ({
      species: row.species.trim(),
      grade: row.grade.trim(),
      thickness: Number(row.thickness),
      width: Number(row.width),
      length: Number(row.length),
      pieces: Number(row.pieces),
      actual_bundles: Number(row.actual),
      unit_price: Number(row.unitPrice || 0),
    }))
    setSaving(true)
    try {
      const result = await createCount({ count_date: countDate, remark: remark.trim(), items })
      setReloadToken((value) => value + 1)
      navigate('/count', { replace: true })
      setToast({
        id: `ok-${Date.now()}`,
        message: `盘点单 ${result.count_no} 已保存`,
      })
    } catch (err) {
      setToast({
        id: `e-${Date.now()}`,
        message: err instanceof Error ? err.message : '保存盘点失败',
      })
    } finally {
      setSaving(false)
    }
  }

  const openDetail = async (row: CountListRow) => {
    tapLight()
    try {
      setDetail(await fetchCountDetail(row.id))
    } catch (err) {
      setToast({
        id: `d-${Date.now()}`,
        message: err instanceof Error ? err.message : '加载详情失败',
      })
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await deleteCount(deleteTarget.id)
      setDeleteTarget(null)
      setDetail(null)
      setReloadToken((value) => value + 1)
      setToast({ id: `del-${Date.now()}`, message: '已撤销盘点单及其调整单' })
    } catch (err) {
      setToast({
        id: `del-${Date.now()}`,
        message: err instanceof Error ? err.message : '撤销失败',
      })
    } finally {
      setDeleting(false)
    }
  }

  if (formMode) {
    return (
      <div className="m-stack" style={{ paddingBottom: 64 }}>
        <MobileCard title="盘点信息">
          <MobileDatePicker label="盘点日期" value={countDate} onChange={setCountDate} />
          <MobileInput label="备注" value={remark} onChange={setRemark} />
          <div className={diffTotal < 0 ? 'm-loss-card is-bad' : 'm-loss-card'}>
            <span>{formRows.length} 个规格</span>
            <strong>差异 {formatCubic(diffTotal)} m³</strong>
          </div>
        </MobileCard>

        {formLoading ? (
          <MobileSkeleton cards={3} />
        ) : (
          <MobileCard title="盘点明细" hint={`${formRows.length} 行`}>
            {formRows.map((row) => {
              const calc = computed.find((item) => item.key === row.key)
              return (
                <div className="m-count-line" key={row.key}>
                  <div className="m-line-editor-head">
                    <span>
                      {row.species || '手动规格'} {row.grade || ''}
                    </span>
                    <b>{row.book} 件账面</b>
                    {row.manual ? (
                      <button
                        type="button"
                        className="m-icon-btn"
                        onClick={() =>
                          setFormRows((prev) => prev.filter((item) => item.key !== row.key))
                        }
                      >
                        ✕
                      </button>
                    ) : null}
                  </div>
                  {row.manual ? (
                    <>
                      <div className="m-line-grid m-line-grid-3">
                        <label className="m-line-field">
                          <span className="m-line-label">品名</span>
                          <input
                            className="m-line-input"
                            value={row.species}
                            onChange={(event) => updateRow(row.key, { species: event.target.value })}
                          />
                        </label>
                        <label className="m-line-field">
                          <span className="m-line-label">等级</span>
                          <input
                            className="m-line-input"
                            value={row.grade}
                            onChange={(event) => updateRow(row.key, { grade: event.target.value })}
                          />
                        </label>
                        <label className="m-line-field">
                          <span className="m-line-label">片/件</span>
                          <input
                            className="m-line-input"
                            inputMode="numeric"
                            value={row.pieces}
                            onChange={(event) => updateRow(row.key, { pieces: event.target.value })}
                          />
                        </label>
                      </div>
                      <div className="m-line-grid m-line-grid-3">
                        <label className="m-line-field">
                          <span className="m-line-label">厚</span>
                          <input
                            className="m-line-input"
                            inputMode="numeric"
                            value={row.thickness}
                            onChange={(event) => updateRow(row.key, { thickness: event.target.value })}
                          />
                        </label>
                        <label className="m-line-field">
                          <span className="m-line-label">宽</span>
                          <input
                            className="m-line-input"
                            inputMode="numeric"
                            value={row.width}
                            onChange={(event) => updateRow(row.key, { width: event.target.value })}
                          />
                        </label>
                        <label className="m-line-field">
                          <span className="m-line-label">长</span>
                          <input
                            className="m-line-input"
                            inputMode="numeric"
                            value={row.length}
                            onChange={(event) => updateRow(row.key, { length: event.target.value })}
                          />
                        </label>
                      </div>
                    </>
                  ) : (
                    <p className="m-count-spec">
                      {row.thickness}×{row.width}×{row.length} · {row.pieces} 片/件
                    </p>
                  )}
                  <div className={money ? 'm-line-grid m-line-grid-2' : 'm-line-grid m-line-grid-1'}>
                    <label className="m-line-field">
                      <span className="m-line-label">实盘件数</span>
                      <input
                        className="m-line-input"
                        inputMode="numeric"
                        value={row.actual}
                        onChange={(event) => updateRow(row.key, { actual: event.target.value })}
                      />
                    </label>
                    {money ? (
                      <label className="m-line-field">
                        <span className="m-line-label">单价</span>
                        <input
                          className="m-line-input"
                          inputMode="numeric"
                          value={row.unitPrice}
                          onChange={(event) => updateRow(row.key, { unitPrice: event.target.value })}
                        />
                      </label>
                    ) : null}
                  </div>
                  <p className={calc && calc.cubic < 0 ? 'm-count-diff is-short' : 'm-count-diff'}>
                    差异 {calc?.diff ?? 0} 件 · {formatCubic(calc?.cubic ?? 0)} m³
                  </p>
                </div>
              )
            })}
            <button
              type="button"
              className="m-btn m-btn-ghost m-add-row"
              onClick={() => setFormRows((prev) => [...prev, createManualRow()])}
            >
              + 手动添加规格
            </button>
          </MobileCard>
        )}

        <div className="m-actionbar m-actionbar-full">
          <button type="button" className="m-btn m-btn-primary" disabled={saving} onClick={() => void save()}>
            {saving ? '保存中…' : '保存'}
          </button>
          <button type="button" className="m-btn m-btn-ghost" onClick={() => goBack(navigate, '/count')}>
            取消
          </button>
        </div>

        <MobileToastHost items={[toast]} />
      </div>
    )
  }

  return (
    <div className="m-stack">
      <MobileTopbarActions>
        <MobileTopbarButton
          label="＋"
          onClick={() => {
            tapLight()
            navigate('/count?mode=new')
          }}
        />
      </MobileTopbarActions>
      <MobileRefreshBar active={refreshing} />

      {loading ? (
        <MobileSkeleton cards={3} />
      ) : rows.length === 0 ? (
        <MobileEmpty
          text="暂无盘点单"
          actionLabel="新增盘点"
          onAction={() => navigate('/count?mode=new')}
        />
      ) : (
        <MobileList>
          {rows.map((row) => (
            <MobileListItem
              key={row.id}
              dense
              title={row.count_no}
              sub={`${row.count_date || '—'} · ${row.remark || '无备注'} · 差异 ${formatCubic(row.diff_cubic)} m³`}
              trail={
                <span className={row.diff_cubic < 0 ? 'm-loss-text is-bad' : 'm-loss-text'}>
                  {row.diff_cubic > 0 ? '盘盈' : row.diff_cubic < 0 ? '盘亏' : '无差异'}
                </span>
              }
              onClick={() => void openDetail(row)}
            />
          ))}
        </MobileList>
      )}

      <MobileSheet
        open={Boolean(detail)}
        title={detail?.count_no || '盘点详情'}
        onClose={() => setDetail(null)}
      >
        {detail ? (
          <>
            <div className="m-rows">
              {[
                ['盘点日期', detail.count_date || '—'],
                ['备注', detail.remark || '—'],
                ['明细数', String(detail.item_count)],
                ['差异立方', `${formatCubic(detail.diff_cubic)} m³`, true],
                ['盘盈单', detail.in_order_no || '—'],
                ['盘亏单', detail.out_order_no || '—'],
              ].map(([label, value, numeric]) => (
                <div className="m-row" key={String(label)}>
                  <span className="m-row-label">{String(label)}</span>
                  <span className={numeric ? 'm-row-value is-num' : 'm-row-value'}>
                    {String(value)}
                  </span>
                </div>
              ))}
            </div>
            <div className="m-detail-title">盘点明细</div>
            {detail.items.map((item) => (
              <div className="m-count-detail-row" key={item.id}>
                <b>
                  {item.species} {item.grade || ''} · {item.thickness}×{item.width}×{item.length}
                </b>
                <span>
                  账面 {item.book_bundles} / 实盘 {item.actual_bundles} · 差异 {item.diff_bundles} 件
                </span>
                <span>{formatCubic(item.diff_cubic)} m³</span>
              </div>
            ))}
            <div className="m-sheet-actions">
              <button
                type="button"
                className="m-btn m-btn-danger"
                onClick={() => {
                  tapHeavy()
                  setDeleteTarget(detail)
                }}
              >
                撤销盘点
              </button>
              <button type="button" className="m-btn m-btn-ghost" onClick={() => setDetail(null)}>
                关闭
              </button>
            </div>
          </>
        ) : null}
      </MobileSheet>

      <MobileModal
        open={Boolean(deleteTarget)}
        title="撤销这张盘点单？"
        message={
          deleteTarget
            ? `${deleteTarget.count_no} 及其生成的盘盈/盘亏单会被撤销，库存会回退。`
            : undefined
        }
        confirmLabel={deleting ? '处理中…' : '确认撤销'}
        danger
        onConfirm={() => void confirmDelete()}
        onClose={() => {
          if (!deleting) setDeleteTarget(null)
        }}
      />

      <MobileToastHost items={[toast]} />
    </div>
  )
}
