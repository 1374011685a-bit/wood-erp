import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
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
import {
  EmptyState,
  PageHead,
  TableSkeleton,
  ToastHost,
} from '../components/Ui'
import { roundTo, formatCubic, formatAmount, todayLocal } from '../utils/num'
import { useRole } from '../hooks/useRole'
import { seesMoney } from '../permissions'
import { readListCache, writeListCache } from '../utils/listCache'

/** 本地日期 YYYY-MM-DD */
type FormRow = {
  key: number
  species: string
  grade: string
  thickness: string
  width: string
  length: string
  pieces: string
  actualBundles: string
  unitPrice: string
  /** 手动加的行：库存列表里没有的规格，账面按 0 算 */
  manual: boolean
}

let rowSeed = 0
const nextKey = () => {
  rowSeed += 1
  return rowSeed
}

const specKey = (row: {
  species: string
  grade: string
  thickness: string | number
  width: string | number
  length: string | number
}) =>
  [
    row.species.trim(),
    row.grade.trim(),
    Number(row.thickness) || 0,
    Number(row.width) || 0,
    Number(row.length) || 0,
  ].join('|')

export default function Count() {
  /**
   * 看不到金额的角色（仓管）：单价列不显示，也就不往接口传单价。
   * 后端在单价缺省时会自动用「该规格最近一次入库单价」估值（count.js 里已有逻辑），
   * 所以盘盈盘亏照样能生成出入库单，成本由后台算。
   */
  const money = seesMoney(useRole())

  const [mode, setMode] = useState<'list' | 'create'>('list')

  const [list, setList] = useState<CountListRow[]>([])
  const [listLoading, setListLoading] = useState(false)
  /** 有缓存时后台静默刷新中 */
  const [refreshing, setRefreshing] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const [stock, setStock] = useState<StockRow[]>([])
  const [rows, setRows] = useState<FormRow[]>([])
  const [form, setForm] = useState({ count_date: todayLocal(), remark: '' })
  const [rowErrors, setRowErrors] = useState<Record<number, string[]>>({})
  const [saving, setSaving] = useState(false)

  const [detail, setDetail] = useState<CountDetail | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CountListRow | null>(null)
  const [deleting, setDeleting] = useState(false)

  const loadList = useCallback(async () => {
    // 缓存先渲染 + 后台静默刷新
    const cached = readListCache<CountListRow[]>('count:list')
    if (cached) {
      setList(cached)
      setRefreshing(true)
    } else {
      setListLoading(true)
    }
    try {
      const next = await fetchCountList()
      setList(next)
      writeListCache('count:list', next)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setListLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void loadList()
  }, [loadList])

  /** 库存规格 → 账面件数 / 立方 / 每件片数，用于实时算差异 */
  const stockMap = useMemo(() => {
    const map = new Map<string, StockRow>()
    for (const row of stock) {
      map.set(
        specKey({
          species: row.species,
          grade: row.grade ?? '',
          thickness: row.thickness,
          width: row.width,
          length: row.length,
        }),
        row,
      )
    }
    return map
  }, [stock])

  const bookFor = useCallback(
    (row: FormRow) => {
      const hit = stockMap.get(specKey(row))
      if (!hit) return { bundles: 0, cubic: 0, piecesPerBundle: 1 }
      const bundles = hit.total_bundles ?? 0
      return {
        bundles,
        cubic: roundTo(hit.total_cubic ?? 0, 4),
        piecesPerBundle:
          bundles > 0
            ? Math.max(1, Math.round((hit.total_pieces ?? 0) / bundles))
            : 1,
      }
    },
    [stockMap],
  )

  /** 每行的差异预览：前端按同一套公式算，服务端保存时还会重算一遍 */
  const computed = useMemo(
    () =>
      rows.map((row) => {
        const book = bookFor(row)
        const piecesPerBundle = Number(row.pieces) > 0 ? Number(row.pieces) : book.piecesPerBundle
        const perBundleCubic = roundTo(
          (Number(row.thickness) * Number(row.width) * Number(row.length) * piecesPerBundle) /
            1000000,
          4,
        )
        const actual = Number(row.actualBundles)
        const diffBundles =
          Number.isFinite(actual) && row.actualBundles.trim() !== ''
            ? actual - book.bundles
            : 0
        const diffCubic = roundTo(diffBundles * perBundleCubic, 4)
        const priceCents = Math.round((Number(row.unitPrice) || 0) * 100)
        const diffAmount = Math.round(diffCubic * priceCents) / 100

        return {
          key: row.key,
          bookBundles: book.bundles,
          bookCubic: book.cubic,
          piecesPerBundle,
          diffBundles,
          diffCubic,
          diffAmount,
        }
      }),
    [rows, bookFor],
  )

  const totals = useMemo(() => {
    const diffCubic = roundTo(
      computed.reduce((sum, row) => sum + row.diffCubic, 0),
      4,
    )
    const diffAmount = roundTo(
      computed.reduce((sum, row) => sum + row.diffAmount, 0),
      2,
    )
    const changed = computed.filter((row) => row.diffBundles !== 0).length
    return { diffCubic, diffAmount, changed }
  }, [computed])

  const openCreate = async () => {
    setError('')
    setRowErrors({})
    setForm({ count_date: todayLocal(), remark: '' })
    try {
      const list = await fetchStockList('')
      setStock(list)
      setRows(
        list.map((row) => {
          const bundles = row.total_bundles ?? 0
          return {
            key: nextKey(),
            species: row.species ?? '',
            grade: row.grade ?? '',
            thickness: String(row.thickness ?? ''),
            width: String(row.width ?? ''),
            length: String(row.length ?? ''),
            pieces: String(
              bundles > 0
                ? Math.max(1, Math.round((row.total_pieces ?? 0) / bundles))
                : 1,
            ),
            // 默认实盘 = 账面，只改盘出来不一样的行
            actualBundles: String(bundles),
            unitPrice:
              row.avg_unit_price === null || row.avg_unit_price === undefined
                ? ''
                : String(row.avg_unit_price),
            manual: false,
          }
        }),
      )
      setMode('create')
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载库存失败')
    }
  }

  const updateRow = (key: number, patch: Partial<FormRow>) => {
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }

  const addRow = () => {
    setRows((prev) => [
      ...prev,
      {
        key: nextKey(),
        species: '',
        grade: '',
        thickness: '',
        width: '',
        length: '',
        pieces: '1',
        actualBundles: '',
        unitPrice: '',
        manual: true,
      },
    ])
  }

  const removeRow = (key: number) => {
    setRows((prev) => prev.filter((row) => row.key !== key))
  }

  const validate = () => {
    const errors: Record<number, string[]> = {}

    for (const row of rows) {
      const reasons: string[] = []
      const thickness = Number(row.thickness)
      const width = Number(row.width)
      const length = Number(row.length)
      const actual = Number(row.actualBundles)
      const price = Number(row.unitPrice || 0)

      if (!row.species.trim()) reasons.push('品名不能为空')
      if (!(thickness > 0 && thickness <= 1000)) reasons.push('厚度需在 0~1000mm')
      if (!(width > 0 && width <= 1000)) reasons.push('宽度需在 0~1000mm')
      if (!(length > 0 && length <= 20)) reasons.push('长度需在 0~20m')
      if (!(Number(row.pieces) > 0)) reasons.push('每件片数需大于 0')
      if (row.actualBundles.trim() === '' || !(actual >= 0)) {
        reasons.push('实盘件数需填写且不小于 0')
      } else if (!Number.isInteger(actual)) {
        reasons.push('实盘件数必须是整数')
      }
      if (!(price >= 0)) reasons.push('单价不能为负数')

      if (reasons.length > 0) errors[row.key] = reasons
    }

    setRowErrors(errors)
    const firstKey = Object.keys(errors)[0]
    return { ok: Object.keys(errors).length === 0, firstKey: Number(firstKey) }
  }

  const handleSave = async () => {
    setError('')
    if (rows.length === 0) {
      setError('至少需要一行盘点明细')
      return
    }

    const { ok } = validate()
    if (!ok) {
      setNotice('有明细没填对，已在对应行标红')
      return
    }

    const items: CountLinePayload[] = rows.map((row) => ({
      species: row.species.trim(),
      grade: row.grade.trim(),
      thickness: Number(row.thickness),
      width: Number(row.width),
      length: Number(row.length),
      pieces: Number(row.pieces),
      actual_bundles: Number(row.actualBundles),
      unit_price: Number(row.unitPrice || 0),
    }))

    setSaving(true)
    try {
      const result = await createCount({
        count_date: form.count_date,
        remark: form.remark,
        items,
      })
      setMode('list')
      await loadList()
      const adjust = [
        result.in_order_no ? `盘盈入库单 ${result.in_order_no}` : '',
        result.out_order_no ? `盘亏出库单 ${result.out_order_no}` : '',
      ]
        .filter(Boolean)
        .join('，')
      setNotice(
        `盘点单 ${result.count_no} 已保存` +
          (adjust ? `，已生成 ${adjust}` : '，无差异，未生成调整单'),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const openDetail = async (row: CountListRow) => {
    setError('')
    try {
      setDetail(await fetchCountDetail(row.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载详情失败')
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    setError('')
    try {
      await deleteCount(deleteTarget.id)
      setDeleteTarget(null)
      setDetail(null)
      setNotice('已撤销该盘点单及其调整单')
      await loadList()
    } catch (err) {
      // 后端说为什么不能删，原文展示，不包装
      setError(err instanceof Error ? err.message : '删除失败')
      setDeleteTarget(null)
    } finally {
      setDeleting(false)
    }
  }

  const modeLabel = (row: CountListRow) => {
    const parts = []
    if (row.in_order_no) parts.push(`盘盈 ${row.in_order_no}`)
    if (row.out_order_no) parts.push(`盘亏 ${row.out_order_no}`)
    return parts.length > 0 ? parts.join('，') : '无差异'
  }

  return (
    <section>
      <PageHead
        title="盘点"
        subtitle="按规格录入实盘件数，差异自动生成盘盈入库单 / 盘亏出库单"
        extra={
          mode === 'list' ? (
            <>
              {refreshing && <span className="list-refreshing">刷新中…</span>}
              <button className="btn btn-primary" onClick={() => void openCreate()}>
                新增盘点
              </button>
            </>
          ) : (
            <button className="btn" onClick={() => setMode('list')}>
              返回列表
            </button>
          )
        }
      />

      <ToastHost
        items={[
          notice
            ? {
                id: 'count-notice',
                kind: 'success' as const,
                message: notice,
                onClose: () => setNotice(''),
              }
            : null,
          error
            ? {
                id: 'count-error',
                kind: 'error' as const,
                message: error,
                onClose: () => setError(''),
              }
            : null,
        ]}
      />

      {mode === 'list' ? (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>单号</th>
                <th>日期</th>
                <th>备注</th>
                <th className="num">差异立方</th>
                <th className="num">明细数</th>
                <th>生成的调整单</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((row) => (
                <tr key={row.id}>
                  <td>{row.count_no}</td>
                  <td>{row.count_date}</td>
                  <td>{row.remark || '—'}</td>
                  <td className={row.diff_cubic < 0 ? 'num is-short' : 'num'}>
                    {formatCubic(row.diff_cubic)}
                  </td>
                  <td className="num">{row.item_count}</td>
                  <td>{modeLabel(row)}</td>
                  <td>
                    <div className="row-actions">
                      <button className="btn btn-sm" onClick={() => void openDetail(row)}>
                        查看
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => setDeleteTarget(row)}
                      >
                        撤销
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {!listLoading && list.length === 0 && (
            <EmptyState
              text="暂无盘点单"
              hint="盘盈会生成入库单、盘亏会生成出库单，库存跟着自动调"
              action={{ label: '新增盘点', onClick: () => void openCreate() }}
            />
          )}
        {listLoading && <TableSkeleton rows={5} cols={5} />}
        </div>
      ) : (
        <div className="card">
          <div className="field-row">
            <label className="field">
              <span>盘点日期</span>
              <input
                className="input"
                type="date"
                value={form.count_date}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, count_date: event.target.value }))
                }
              />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>备注</span>
              <input
                className="input"
                value={form.remark}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, remark: event.target.value }))
                }
              />
            </label>
          </div>

          <table className="table table-detail">
            <thead>
              <tr>
                <th>品名</th>
                <th>等级</th>
                <th className="num">厚度mm</th>
                <th className="num">宽度mm</th>
                <th className="num">长度m</th>
                <th className="num">片数/件</th>
                <th className="num">账面件数</th>
                <th className="num">实盘件数</th>
                <th className="num">差异件数</th>
                <th className="num">差异立方</th>
                {/* 看不到金额的角色：单价留空交给后台按最近入库价算，这一列和差异金额都不显示 */}
                {money && <th className="num">单价</th>}
                {money && <th className="num">差异金额</th>}
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const calc = computed.find((item) => item.key === row.key)
                const reasons = rowErrors[row.key]
                return (
                  <Fragment key={row.key}>
                    <tr>
                      <td>
                        <input
                          className={
                            row.manual ? 'input input-cell' : 'input input-cell input-locked'
                          }
                          value={row.species}
                          readOnly={!row.manual}
                          placeholder={row.manual ? '品名' : ''}
                          onChange={(event) => updateRow(row.key, { species: event.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          className={
                            row.manual ? 'input input-cell' : 'input input-cell input-locked'
                          }
                          value={row.grade}
                          readOnly={!row.manual}
                          onChange={(event) => updateRow(row.key, { grade: event.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          className={
                            row.manual ? 'input input-cell' : 'input input-cell input-locked'
                          }
                          inputMode="decimal"
                          value={row.thickness}
                          readOnly={!row.manual}
                          onChange={(event) =>
                            updateRow(row.key, { thickness: event.target.value })
                          }
                        />
                      </td>
                      <td>
                        <input
                          className={
                            row.manual ? 'input input-cell' : 'input input-cell input-locked'
                          }
                          inputMode="decimal"
                          value={row.width}
                          readOnly={!row.manual}
                          onChange={(event) => updateRow(row.key, { width: event.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          className={
                            row.manual ? 'input input-cell' : 'input input-cell input-locked'
                          }
                          inputMode="decimal"
                          value={row.length}
                          readOnly={!row.manual}
                          onChange={(event) => updateRow(row.key, { length: event.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          className="input input-cell"
                          inputMode="numeric"
                          value={row.pieces}
                          onChange={(event) => updateRow(row.key, { pieces: event.target.value })}
                        />
                      </td>
                      <td className="num">{calc?.bookBundles ?? 0}</td>
                      <td>
                        <input
                          className={
                            reasons ? 'input input-cell input-error' : 'input input-cell'
                          }
                          inputMode="numeric"
                          value={row.actualBundles}
                          onChange={(event) =>
                            updateRow(row.key, { actualBundles: event.target.value })
                          }
                        />
                      </td>
                      <td className={calc && calc.diffBundles < 0 ? 'num is-short' : 'num'}>
                        {calc ? (calc.diffBundles > 0 ? `+${calc.diffBundles}` : calc.diffBundles) : 0}
                      </td>
                      <td className={calc && calc.diffCubic < 0 ? 'num is-short' : 'num'}>
                        {calc ? formatCubic(calc.diffCubic) : '0'}
                      </td>
                      {money && (
                        <td>
                          <input
                            className="input input-cell"
                            inputMode="decimal"
                            value={row.unitPrice}
                            onChange={(event) =>
                              updateRow(row.key, { unitPrice: event.target.value })
                            }
                          />
                        </td>
                      )}
                      {money && (
                        <td className="num amount">
                          {calc ? formatAmount(calc.diffAmount) : '0.00'}
                        </td>
                      )}
                      <td>
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() => removeRow(row.key)}
                        >
                          删行
                        </button>
                      </td>
                    </tr>
                    {reasons && (
                      <tr>
                        <td colSpan={13} className="row-error">
                          {reasons.join('；')}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>

          {rows.length === 0 && <EmptyState text="没有可盘点的规格，可手动加一行盘盈" />}

          <div className="row-tools">
            <button className="btn" onClick={addRow}>
              + 加一行
            </button>
            <span className="muted">
              账面件数来自实时库存；默认实盘 = 账面，只改盘点结果不一样的行。盘盈写入库单、盘亏写出库单。
            </span>
          </div>

          <div className="totals">
            <span>有差异 {totals.changed} 行</span>
            <span>合计差异立方：{formatCubic(totals.diffCubic)}</span>
            {money && <span>合计差异金额：{formatAmount(totals.diffAmount)}</span>}
          </div>

          <div className="row-tools">
            <button
              className="btn btn-primary"
              onClick={() => void handleSave()}
              disabled={saving}
            >
              {saving ? '保存中…' : '保存'}
            </button>
            <button className="btn" onClick={() => setMode('list')} disabled={saving}>
              取消
            </button>
            <span className="muted">单号保存时自动生成（PD + 日期 + 流水）</span>
          </div>
        </div>
      )}

      {detail && (
        <div className="overlay" onClick={() => setDetail(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h2 className="modal-title">盘点单详情：{detail.count_no}</h2>
              <div className="modal-actions">
                <button className="btn btn-sm btn-quiet" onClick={() => setDetail(null)}>
                  关闭
                </button>
              </div>
            </div>

            <div className="meta">
              <span>日期：{detail.count_date}</span>
              <span>备注：{detail.remark || '—'}</span>
              <span>合计差异：{formatCubic(detail.diff_cubic)} 立方</span>
              <span>创建时间：{detail.created_at}</span>
              {detail.in_order_no && <span>盘盈入库单：{detail.in_order_no}</span>}
              {detail.out_order_no && <span>盘亏出库单：{detail.out_order_no}</span>}
            </div>

            <table className="table">
              <thead>
                <tr>
                  <th>品名</th>
                  <th>等级</th>
                  <th className="num">厚度mm</th>
                  <th className="num">宽度mm</th>
                  <th className="num">长度m</th>
                  <th className="num">片数/件</th>
                  <th className="num">账面件数</th>
                  <th className="num">实盘件数</th>
                  <th className="num">差异件数</th>
                  <th className="num">账面立方</th>
                  <th className="num">差异立方</th>
                  {money && <th className="num">单价</th>}
                </tr>
              </thead>
              <tbody>
                {detail.items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.species}</td>
                    <td>{item.grade || '—'}</td>
                    <td className="num">{item.thickness}</td>
                    <td className="num">{item.width}</td>
                    <td className="num">{item.length}</td>
                    <td className="num">{item.pieces}</td>
                    <td className="num">{item.book_bundles}</td>
                    <td className="num">{item.actual_bundles}</td>
                    <td className={item.diff_bundles < 0 ? 'num is-short' : 'num'}>
                      {item.diff_bundles > 0 ? `+${item.diff_bundles}` : item.diff_bundles}
                    </td>
                    <td className="num">{formatCubic(item.book_cubic)}</td>
                    <td className={item.diff_cubic < 0 ? 'num is-short' : 'num'}>
                      {formatCubic(item.diff_cubic)}
                    </td>
                    {money && (
                      <td className="num amount">{formatAmount(item.unit_price)}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="overlay" onClick={() => setDeleteTarget(null)}>
          <div
            className="modal modal-narrow modal-alert"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="modal-title">撤销盘点</h2>
            <p className="confirm-text">
              确认撤销盘点单 {deleteTarget.count_no}？它生成的盘盈 / 盘亏单会一起删掉，
              此操作不可恢复。
            </p>
            <div className="confirm-actions">
              <button
                className="btn"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
              >
                取消
              </button>
              <button
                className="btn btn-danger-solid"
                onClick={() => void confirmDelete()}
                disabled={deleting}
              >
                {deleting ? '撤销中…' : '确认撤销'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
