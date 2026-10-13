import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createRepack,
  deleteRepack,
  fetchRepackBales,
  fetchRepackList,
  fetchDict,
  type RepackBale,
  type RepackLine,
  type RepackRow,
  type RepackSums,
} from '../api'
import { EmptyState, Loading, PageHead, Pager, ToastHost } from '../components/Ui'
import { toNumber, roundTo, formatCubic, formatAmount, todayISO } from '../utils/num'

const PAGE_SIZE = 20

/** 改包后的一行（一包里的一个规格） */
type AfterRow = {
  key: number
  species: string
  grade: string
  thickness: string
  width: string
  length: string
  pieces: string
  /** 留空 = 按改前成本自动算 */
  unitPrice: string
}

let rowSeq = 0
const createRow = (): AfterRow => ({
  key: (rowSeq += 1),
  species: '',
  grade: '',
  thickness: '',
  width: '',
  length: '',
  pieces: '',
  unitPrice: '',
})

const rowFromLine = (line: RepackLine): AfterRow => ({
  key: (rowSeq += 1),
  species: line.species ?? '',
  grade: line.grade ?? '',
  thickness: String(line.thickness ?? ''),
  width: String(line.width ?? ''),
  length: String(line.length ?? ''),
  pieces: String(line.pieces ?? ''),
  unitPrice: '',
})

/** 一行的立方：厚 × 宽 × 长 × 片数 ÷ 1,000,000（一包就是一件） */
const rowCubic = (row: AfterRow) =>
  roundTo(
    (toNumber(row.thickness) *
      toNumber(row.width) *
      toNumber(row.length) *
      toNumber(row.pieces)) /
      1000000,
    4,
  )

const lineCubic = (line: RepackLine) => roundTo(line.cubic ?? 0, 4)

export default function Repack() {
  const [bales, setBales] = useState<RepackBale[]>([])
  const [baleId, setBaleId] = useState(0)
  const [rows, setRows] = useState<AfterRow[]>(() => [createRow()])
  const [form, setForm] = useState({
    repackDate: todayISO(),
    summary: '',
    remark: '',
    blNo: '',
    contractNo: '',
  })
  const [saving, setSaving] = useState(false)
  // 默认进来看改包记录，点「新增改包」才进录入界面
  const [formOpen, setFormOpen] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [list, setList] = useState<RepackRow[]>([])
  const [sums, setSums] = useState<RepackSums | null>(null)
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [filters, setFilters] = useState({ date_to: '', species: '' })
  const [query, setQuery] = useState({ date_to: '', species: '' })
  const [loading, setLoading] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const [undoTarget, setUndoTarget] = useState<RepackRow | null>(null)
  const [dict, setDict] = useState<{ species: string[]; grade: string[] }>({
    species: [],
    grade: [],
  })

  const bale = useMemo(
    () => bales.find((item) => item.id === baleId) ?? null,
    [bales, baleId],
  )

  const loadBales = useCallback(async () => {
    try {
      setBales(await fetchRepackBales())
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载可改包的码单失败')
    }
  }, [])

  const loadList = useCallback(async (nextQuery: typeof query, nextOffset: number) => {
    setLoading(true)
    try {
      const page = await fetchRepackList({
        date_to: nextQuery.date_to || undefined,
        species: nextQuery.species.trim() || undefined,
        limit: PAGE_SIZE,
        offset: nextOffset,
      })
      setList(page.rows)
      setTotal(page.total)
      setSums(page.sums)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载改包记录失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadBales()
  }, [loadBales, reloadToken])

  useEffect(() => {
    void fetchDict()
      .then((data) =>
        setDict({
          species: data.species.map((item) => item.name),
          grade: data.grade.map((item) => item.name),
        }),
      )
      .catch(() => {
        // 拉不到就退化成手填
      })
  }, [])

  useEffect(() => {
    void loadList(query, offset)
  }, [loadList, query, offset, reloadToken])

  /** 改前总成本 = 每一行 立方 × 那一行的入库单价 */
  const beforeCubic = useMemo(
    () =>
      roundTo(
        (bale?.items ?? []).reduce((sum, line) => sum + lineCubic(line), 0),
        4,
      ),
    [bale],
  )
  const beforeAmount = useMemo(
    () =>
      roundTo(
        (bale?.items ?? []).reduce(
          (sum, line) => sum + lineCubic(line) * (line.unit_price ?? 0),
          0,
        ),
        2,
      ),
    [bale],
  )

  const afterCubic = useMemo(
    () => roundTo(rows.reduce((sum, row) => sum + rowCubic(row), 0), 4),
    [rows],
  )

  /**
   * 改后成本单价：
   * - 用户填了单价 → 用他填的，不再随改前成本变；
   * - 没填 → 改前总成本 ÷ 改后总方数，改前成本一变它跟着变。
   */
  const pinned = rows.some((row) => toNumber(row.unitPrice) > 0)
  const derivedPrice = afterCubic > 0 ? roundTo(beforeAmount / afterCubic, 2) : 0
  const priceOf = (row: AfterRow) =>
    toNumber(row.unitPrice) > 0 ? toNumber(row.unitPrice) : derivedPrice
  const afterAmount = useMemo(
    () => roundTo(rows.reduce((sum, row) => sum + rowCubic(row) * priceOf(row), 0), 2),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, derivedPrice],
  )

  const pickBale = (id: number) => {
    setBaleId(id)
    const hit = bales.find((item) => item.id === id)
    setRows(
      hit && hit.items.length > 0 ? hit.items.map(rowFromLine) : [createRow()],
    )
    setForm((prev) => ({
      ...prev,
      // 提单号 / 合同号默认跟着改前（柜上的），要改就自己填
      blNo: hit?.bl_no ?? '',
      contractNo: hit?.contract_no ?? '',
    }))
    setError('')
  }

  const copyBefore = () => {
    if (!bale) return
    setRows(bale.items.map(rowFromLine))
  }

  const updateRow = (key: number, field: keyof AfterRow, value: string) => {
    setRows((prev) =>
      prev.map((row) => (row.key === key ? { ...row, [field]: value } : row)),
    )
  }

  const addRow = () => setRows((prev) => [...prev, createRow()])

  /** 新增一行：复制当前最后一行的规格，省得重复填（单价不带过去，免得手滑钉住成本） */
  const copyLastRow = () =>
    setRows((prev) => {
      const last = prev[prev.length - 1]
      if (!last) return [...prev, createRow()]
      const { key, unitPrice, ...rest } = last
      void key
      void unitPrice
      return [...prev, { ...createRow(), ...rest }]
    })

  const removeRow = (key: number) => {
    setRows((prev) =>
      prev.length > 1 ? prev.filter((row) => row.key !== key) : [createRow()],
    )
  }

  const handleSave = async () => {
    setError('')
    if (!bale) {
      setError('请先选择要改的那一包')
      return
    }
    const filled = rows.filter((row) => row.species.trim())
    if (filled.length === 0) {
      setError('改包后至少要有一行规格')
      return
    }

    const problems: string[] = []
    filled.forEach((row, index) => {
      const reasons: string[] = []
      if (!(toNumber(row.thickness) > 0)) reasons.push('厚度要大于 0')
      if (!(toNumber(row.width) > 0)) reasons.push('宽度要大于 0')
      if (!(toNumber(row.length) > 0)) reasons.push('长度要大于 0')
      if (!(Number.isInteger(toNumber(row.pieces)) && toNumber(row.pieces) > 0)) {
        reasons.push('片数要是大于 0 的整数')
      }
      if (reasons.length > 0) problems.push(`第 ${index + 1} 行：${reasons.join('；')}`)
    })
    if (problems.length > 0) {
      setError(problems.join('\n'))
      return
    }

    setSaving(true)
    try {
      const result = await createRepack({
        repack_date: form.repackDate,
        bale_id: bale.id,
        summary: form.summary.trim(),
        remark: form.remark.trim(),
        bl_no: form.blNo.trim(),
        contract_no: form.contractNo.trim(),
        after_items: filled.map((row) => ({
          species: row.species.trim(),
          grade: row.grade.trim(),
          thickness: toNumber(row.thickness),
          width: toNumber(row.width),
          length: toNumber(row.length),
          pieces: toNumber(row.pieces),
          unit_price: toNumber(row.unitPrice),
        })),
      })
      setNotice(`已改包 ${result.repack_no}，库存已按新规格同步`)
      setBaleId(0)
      setRows([createRow()])
      setForm((prev) => ({ ...prev, summary: '', remark: '', blNo: '', contractNo: '' }))
      setFormOpen(false)
      setReloadToken((n) => n + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : '改包失败')
    } finally {
      setSaving(false)
    }
  }

  const confirmUndo = async () => {
    if (!undoTarget) return
    try {
      await deleteRepack(undoTarget.id)
      setNotice(`已撤销改包 ${undoTarget.repack_no}，这一包的规格回到改包前`)
      setUndoTarget(null)
      setReloadToken((n) => n + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : '撤销失败')
      setUndoTarget(null)
    }
  }

  const lossCubic = roundTo(afterCubic - beforeCubic, 4)
  // 损耗率 = 损耗方数 ÷ 改前方数
  const lossRate = beforeCubic > 0 ? roundTo((lossCubic / beforeCubic) * 100, 2) : null
  const lossArrow = lossCubic > 0 ? '↑' : lossCubic < 0 ? '↓' : ''

  return (
    <section>
      <PageHead
        title="改包"
        subtitle={
          formOpen
            ? '选一包，改成品名 / 等级 / 规格，改前改后和损耗都留痕，库存跟着自动同步'
            : '一包货换了品名 / 等级 / 规格都记在这里，可查可撤销'
        }
        extra={
          formOpen ? (
            <button className="btn" onClick={() => setFormOpen(false)}>
              返回改包记录
            </button>
          ) : (
            <button className="btn btn-primary" onClick={() => setFormOpen(true)}>
              新增改包
            </button>
          )
        }
      />

      <ToastHost
        items={[
          notice
            ? {
                id: 'repack-notice',
                kind: 'success' as const,
                message: notice,
                onClose: () => setNotice(''),
              }
            : null,
          error
            ? {
                id: 'repack-error',
                kind: 'error' as const,
                message: error,
                onClose: () => setError(''),
              }
            : null,
        ]}
      />

      <datalist id="repack-species">
        {dict.species.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <datalist id="repack-grade">
        {dict.grade.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>

      {/* 录入界面：点「新增改包」才出现 */}
      {formOpen && (
        <div className="card sheet">
        <div className="sheet-top">
          <label className="sheet-field">
            <span>日期</span>
            <input
              className="input"
              type="date"
              value={form.repackDate}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, repackDate: event.target.value }))
              }
            />
          </label>
          <label className="sheet-field">
            <span>单号</span>
            <input className="input input-readonly" readOnly value="默认系统生成" />
          </label>
          <label className="sheet-field">
            <span>摘要</span>
            <input
              className="input"
              placeholder="例如：1 改 2"
              value={form.summary}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, summary: event.target.value }))
              }
            />
          </label>
          <span className="spacer" />
          <button className="btn btn-primary" onClick={() => void handleSave()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>

        {/* 改包前：只读 */}
        <div className="sheet-toolbar">
          <span className="section-tag">改包前</span>
          <select
            className="input sheet-pick"
            value={baleId}
            onChange={(event) => pickBale(Number(event.target.value))}
          >
            <option value={0}>选择要改的那一包（条码号 / 包号）…</option>
            {bales.map((item) => (
              <option key={item.id} value={item.id}>
                {item.barcode || item.bale_no} · 包号 {item.bale_no || '—'} ·{' '}
                {item.items.map((line) => line.species).join('+') || '—'} ·{' '}
                {formatCubic(item.cubic)} 立方
              </option>
            ))}
          </select>
          <span className="spacer" />
          <span className="muted">
            {bale
              ? `提单 ${bale.bl_no || '—'}　合同 ${bale.contract_no || '—'}`
              : `在库可改包的码单 ${bales.length} 张`}
          </span>
        </div>

        <div className="sheet-scroll">
          <table className="sheet-table">
            <thead>
              <tr>
                <th className="col-no">#</th>
                <th>包号</th>
                <th className="col-name">品名</th>
                <th>等级</th>
                <th>厚度</th>
                <th>宽度</th>
                <th>长度</th>
                <th>片数</th>
                <th className="col-unit">数量</th>
                <th className="col-unit">单位</th>
                <th>单价</th>
                <th>金额</th>
                <th className="col-code">条码号</th>
              </tr>
            </thead>
            <tbody>
              {bale ? (
                bale.items.map((line, index) => (
                  <tr key={`${line.species}-${index}`}>
                    <td className="col-no">{index + 1}</td>
                    <td>{bale.bale_no || '—'}</td>
                    <td>{line.species}</td>
                    <td>{line.grade || '—'}</td>
                    <td>{line.thickness}</td>
                    <td>{line.width}</td>
                    <td>{line.length}</td>
                    <td>{line.pieces}</td>
                    <td className="col-unit num">{formatCubic(lineCubic(line))}</td>
                    <td className="col-unit">m³</td>
                    <td className="num">{formatAmount(line.unit_price ?? 0)}</td>
                    <td className="num">
                      {formatAmount(lineCubic(line) * (line.unit_price ?? 0))}
                    </td>
                    <td className="col-code">{bale.barcode || '—'}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={13} className="sheet-empty">
                    上面选一包，这里就会显示它改之前的规格
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={8} className="sheet-total-label">
                  合计
                </td>
                <td className="num">{formatCubic(beforeCubic)}</td>
                <td>m³</td>
                <td />
                <td className="num">{formatAmount(beforeAmount)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>

        {/* 改包后：可编辑 */}
        <div className="sheet-toolbar">
          <span className="section-tag">改包后</span>
          <button className="btn btn-sm" onClick={copyBefore} disabled={!bale}>
            复制改包前数据
          </button>
            <button className="btn btn-sm" onClick={copyLastRow}>
              + 新增（复制当前行）
            </button>
            <button className="btn btn-sm" onClick={addRow}>
              + 空白行
            </button>
          <span className="spacer" />
          <span className="muted">
            单价留空 = 按「改前总成本 ÷ 改后总方数」自动算；自己填了就以你填的为准
          </span>
        </div>

        <div className="sheet-scroll">
          <table className="sheet-table">
            <thead>
              <tr>
                <th className="col-no">#</th>
                <th className="col-op">操作</th>
                <th className="col-name">品名 *</th>
                <th>等级</th>
                <th>厚度</th>
                <th>宽度</th>
                <th>长度</th>
                <th>片数</th>
                <th className="col-unit">数量</th>
                <th className="col-unit">单位</th>
                <th>单价{pinned ? '' : '（自动）'}</th>
                <th>金额</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const cubic = rowCubic(row)
                return (
                  <tr key={row.key}>
                    <td className="col-no">{index + 1}</td>
                    <td className="col-op">
                      <button
                        type="button"
                        className="sheet-icon sheet-icon-danger"
                        title="删掉这一行"
                        onClick={() => removeRow(row.key)}
                      >
                        ✕
                      </button>
                    </td>
                    <td>
                      <input
                        className="sheet-input"
                        list="repack-species"
                        value={row.species}
                        onChange={(event) => updateRow(row.key, 'species', event.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        className="sheet-input"
                        list="repack-grade"
                        value={row.grade}
                        onChange={(event) => updateRow(row.key, 'grade', event.target.value)}
                      />
                    </td>
                    {(['thickness', 'width', 'length', 'pieces'] as const).map((field) => (
                      <td key={field}>
                        <input
                          className="sheet-input"
                          type="text"
                          inputMode="decimal"
                          value={row[field]}
                          onChange={(event) => updateRow(row.key, field, event.target.value)}
                        />
                      </td>
                    ))}
                    <td className="col-unit num">{cubic ? formatCubic(cubic) : ''}</td>
                    <td className="col-unit">{cubic ? 'm³' : ''}</td>
                    <td>
                      <input
                        className="sheet-input"
                        type="text"
                        inputMode="decimal"
                        placeholder={derivedPrice ? String(derivedPrice) : '自动'}
                        value={row.unitPrice}
                        onChange={(event) => updateRow(row.key, 'unitPrice', event.target.value)}
                      />
                    </td>
                    <td className="num">{cubic ? formatAmount(cubic * priceOf(row)) : ''}</td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={8} className="sheet-total-label">
                  合计
                </td>
                <td className="num">{formatCubic(afterCubic)}</td>
                <td>m³</td>
                <td />
                <td className="num">{formatAmount(afterAmount)}</td>
              </tr>
              <tr>
                <td colSpan={8} className="sheet-total-label">
                  损耗（改后 − 改前）
                </td>
                <td className={lossCubic < 0 ? 'num is-short' : 'num'}>
                  {formatCubic(lossCubic)} {lossArrow}
                </td>
                <td>
                  {lossRate === null ? '—' : `${lossRate}% ${lossArrow}`}
                </td>
                <td />
                <td className="num">
                  {formatAmount(roundTo(afterAmount - beforeAmount, 2))}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="sheet-bottom">
          <label className="sheet-field">
            <span>提单号（留空就跟改前一致）</span>
            <input
              className="input"
              value={form.blNo}
              onChange={(event) => setForm((prev) => ({ ...prev, blNo: event.target.value }))}
            />
            {!form.blNo.trim() && bale?.bl_no && (
              <span className="hint">
                改前提单号是 {bale.bl_no}，你留空了 —— 保存时会自动同步成 {bale.bl_no}
              </span>
            )}
          </label>
          <label className="sheet-field">
            <span>合同号（留空就跟改前一致）</span>
            <input
              className="input"
              value={form.contractNo}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, contractNo: event.target.value }))
              }
            />
            {!form.contractNo.trim() && bale?.contract_no && (
              <span className="hint">
                改前合同号是 {bale.contract_no}，你留空了 —— 保存时会自动同步
              </span>
            )}
          </label>
        </div>

        <textarea
          className="input textarea sheet-note"
          placeholder="备注（选填）"
          value={form.remark}
          onChange={(event) => setForm((prev) => ({ ...prev, remark: event.target.value }))}
        />

        <p className="hint">
          提单号 / 合同号留空时跟着改前那一包走；填了就按你填的记进改包记录。
        </p>
        </div>
      )}

      {/* 改包记录：进来先看这个 */}
      {!formOpen && (
        <div className="card">
        <h2 className="section-title">改包记录</h2>

        <div className="toolbar">
          <input
            className="input"
            type="date"
            value={filters.date_to}
            onChange={(event) =>
              setFilters((prev) => ({ ...prev, date_to: event.target.value }))
            }
          />
          <input
            className="input"
            placeholder="品名关键字"
            value={filters.species}
            onChange={(event) =>
              setFilters((prev) => ({ ...prev, species: event.target.value }))
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                setOffset(0)
                setQuery(filters)
              }
            }}
          />
          <button
            className="btn"
            onClick={() => {
              setOffset(0)
              setQuery(filters)
            }}
          >
            查询
          </button>
          <button
            className="btn"
            onClick={() => {
              const empty = { date_to: '', species: '' }
              setFilters(empty)
              setOffset(0)
              setQuery(empty)
            }}
          >
            重置
          </button>
        </div>

        <table className="table">
          <thead>
            <tr>
              <th>日期</th>
              <th>单号</th>
              <th>包号</th>
              <th>条码号</th>
              <th>提单号</th>
              <th>改前</th>
              <th>改后</th>
              <th className="num">改前立方</th>
              <th className="num">改后立方</th>
              <th className="num">损耗</th>
              <th className="num">损耗率</th>
              <th>摘要</th>
              <th>制单人</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {list.map((row) => (
              <tr key={row.id}>
                <td>{row.repack_date}</td>
                <td>{row.repack_no}</td>
                <td>{row.bale_no || '—'}</td>
                <td>{row.barcode || '—'}</td>
                <td>{row.bl_no || '—'}</td>
                <td>
                  {row.before_items
                    .map((line) => `${line.species}${line.grade ? `/${line.grade}` : ''}`)
                    .join('、') || '—'}
                </td>
                <td>
                  {row.after_items
                    .map((line) => `${line.species}${line.grade ? `/${line.grade}` : ''}`)
                    .join('、') || '—'}
                </td>
                <td className="num">{formatCubic(row.before_cubic)}</td>
                <td className="num">{formatCubic(row.after_cubic)}</td>
                <td className={row.loss_cubic < 0 ? 'num is-short' : 'num'}>
                  {formatCubic(row.loss_cubic)}
                  {row.loss_cubic > 0 ? ' ↑' : row.loss_cubic < 0 ? ' ↓' : ''}
                </td>
                <td className="num">
                  {row.loss_rate === null ? '—' : `${row.loss_rate}%`}
                  {row.loss_rate === null
                    ? ''
                    : row.loss_rate > 0
                      ? ' ↑'
                      : row.loss_rate < 0
                        ? ' ↓'
                        : ''}
                </td>
                <td>{row.summary || '—'}</td>
                <td>{row.created_by || '—'}</td>
                <td>
                  <button className="btn btn-sm btn-danger" onClick={() => setUndoTarget(row)}>
                    撤销
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={7} className="sheet-total-label">
                合计
              </td>
              <td className="num">{formatCubic(sums?.before_cubic ?? 0)}</td>
              <td className="num">{formatCubic(sums?.after_cubic ?? 0)}</td>
              <td className="num">{formatCubic(sums?.loss_cubic ?? 0)}</td>
              <td colSpan={3} />
            </tr>
          </tfoot>
        </table>

        {!loading && list.length === 0 && <EmptyState text="还没有改包记录" />}
        {loading && <Loading />}

        <Pager
          total={total}
          limit={PAGE_SIZE}
          offset={offset}
          onChange={setOffset}
          unit="条改包记录"
        />
        </div>
      )}

      {undoTarget && (
        <div className="overlay" onClick={() => setUndoTarget(null)}>
          <div
            className="modal modal-narrow modal-alert"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="modal-title">撤销改包</h2>
            <p className="confirm-text">
              确认撤销改包 {undoTarget.repack_no}？这一包的规格会回到改包前
              （{undoTarget.before_items.map((line) => line.species).join('、') || '—'}），
              库存跟着改回去，这条记录也会删掉。
            </p>
            <div className="confirm-actions">
              <button className="btn" onClick={() => setUndoTarget(null)}>
                取消
              </button>
              <button className="btn btn-danger-solid" onClick={() => void confirmUndo()}>
                确认撤销
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
