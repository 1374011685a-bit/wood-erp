import { useCallback, useEffect, useState } from 'react'
import { fetchRecords, type RecordQuery, type RecordRow } from '../api'
import {
  EmptyState,
  PageHead,
  Pager,
  TableSkeleton,
  ToastHost,
} from '../components/Ui'
import { formatCubic, formatAmount } from '../utils/num'
import { useRole } from '../hooks/useRole'
import { seesMoney } from '../permissions'
import { readListCache, writeListCache } from '../utils/listCache'

const typeLabel = (type: 'in' | 'out') => (type === 'in' ? '入库' : '出库')

const PAGE_SIZE = 50

export default function Records() {
  // 看不到金额的角色：单价 / 金额两列不渲染（后端也不返回这两个字段）
  const money = seesMoney(useRole())

  const [rows, setRows] = useState<RecordRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  /** 有缓存时后台静默刷新中 */
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')

  // 筛选条件（输入中的草稿）
  const [typeInput, setTypeInput] = useState<'' | 'in' | 'out'>('')
  const [speciesInput, setSpeciesInput] = useState('')
  const [partnerInput, setPartnerInput] = useState('')
  /** 手机端：筛选字段收进底部 sheet */
  const [filterOpen, setFilterOpen] = useState(false)
  const [dateFromInput, setDateFromInput] = useState('')
  const [dateToInput, setDateToInput] = useState('')
  /** 「筛选」按钮上的角标：当前生效了几个条件（不含关键词搜索框） */
  const activeFilterCount = [typeInput, partnerInput, dateFromInput, dateToInput].filter(
    Boolean,
  ).length

  // 已生效的筛选条件
  const [query, setQuery] = useState<RecordQuery>({ limit: PAGE_SIZE, offset: 0 })

  const load = useCallback(async (next: RecordQuery) => {
    // 有缓存先渲染（切回来不闪空白），再后台静默刷新；没缓存才给骨架
    const cacheKey = `records:${JSON.stringify(next)}`
    const cached = readListCache<{ rows: RecordRow[]; total: number }>(cacheKey)
    if (cached) {
      setRows(cached.rows)
      setTotal(cached.total)
      setRefreshing(true)
    } else {
      setLoading(true)
    }
    setError('')
    try {
      const result = await fetchRecords(next)
      setRows(result.records)
      setTotal(result.total)
      writeListCache(cacheKey, { rows: result.records, total: result.total })
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load(query)
  }, [load, query])

  const handleSearch = () =>
    setQuery({
      type: typeInput,
      species: speciesInput.trim(),
      partner: partnerInput.trim(),
      date_from: dateFromInput,
      date_to: dateToInput,
      limit: PAGE_SIZE,
      offset: 0,
    })

  const handleReset = () => {
    setTypeInput('')
    setSpeciesInput('')
    setPartnerInput('')
    setDateFromInput('')
    setDateToInput('')
    setQuery({ limit: PAGE_SIZE, offset: 0 })
  }

  const goPage = (nextOffset: number) =>
    setQuery((prev) => ({ ...prev, offset: nextOffset }))

  return (
    <section>
      <PageHead
        title="流水"
        subtitle="入库与出库的全部明细，按时间倒序，可按类型、品名、往来单位、日期筛选"
      />

      <ToastHost
        items={[
          error
            ? {
                id: 'records-error',
                kind: 'error' as const,
                message: error,
                onClose: () => setError(''),
              }
            : null,
        ]}
      />

      <div className="toolbar toolbar-sticky">
        <input
          className="input toolbar-search"
          placeholder="品名 / 供应商 / 单号"
          value={speciesInput}
          onChange={(event) => setSpeciesInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') handleSearch()
          }}
        />
        <button
          type="button"
          className="btn filter-toggle"
          onClick={() => setFilterOpen((open) => !open)}
        >
          筛选
          {activeFilterCount > 0 ? ` · ${activeFilterCount}` : ''}
        </button>
        <div className={filterOpen ? 'filter-sheet is-open' : 'filter-sheet'}>
          <div className="filter-sheet-head">
            <span>筛选</span>
            <button
              type="button"
              className="btn btn-sm btn-quiet"
              onClick={() => setFilterOpen(false)}
            >
              关闭
            </button>
          </div>
        <select
          className="input"
          value={typeInput}
          onChange={(event) => setTypeInput(event.target.value as '' | 'in' | 'out')}
        >
          <option value="">全部</option>
          <option value="in">入库</option>
          <option value="out">出库</option>
        </select>
        <input
          className="input"
          placeholder="供应商/客户关键字"
          value={partnerInput}
          onChange={(event) => setPartnerInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') handleSearch()
          }}
        />
        <input
          className="input"
          type="date"
          value={dateFromInput}
          onChange={(event) => setDateFromInput(event.target.value)}
        />
        <span className="muted">至</span>
        <input
          className="input"
          type="date"
          value={dateToInput}
          onChange={(event) => setDateToInput(event.target.value)}
        />
          <div className="filter-sheet-actions">
            <button className="btn" onClick={handleReset}>
              重置
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                handleSearch()
                setFilterOpen(false)
              }}
            >
              查询
            </button>
          </div>
        </div>
        {filterOpen && (
          <div className="filter-sheet-mask" onClick={() => setFilterOpen(false)} />
        )}
        <span className="spacer" />
        {refreshing && <span className="list-refreshing">刷新中…</span>}
        <span className="muted">共 {total} 条</span>
      </div>

      <div className="card">
        {/* records-table：13 列，单元格内边距单独收紧一档（见 index.css） */}
        <table className="table records-table">
          <thead>
            <tr>
              <th>类型</th>
              <th>时间</th>
              <th>单号</th>
              <th>供应商/客户</th>
              <th>品名</th>
              <th>等级</th>
              {/* 厚度 + 宽度 合并成「规格」：33×22 —— 两列并一列，14 列压到 13 列 */}
              <th className="num">规格 (mm)</th>
              <th className="num">长度 (m)</th>
              <th className="num">片数</th>
              <th className="num">件数</th>
              <th className="num">立方</th>
              {money && <th className="num">单价</th>}
              {money && <th className="num">金额</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.record_id}>
                <td className="col-third">
                  <span
                    className={
                      row.order_type === 'in' ? 'tag tag-in' : 'tag tag-out'
                    }
                  >
                    {typeLabel(row.order_type)}
                  </span>
                </td>
                {/* 时间只显示到分（秒挂在 title 上）：这一列原来是 159px，是流水表里最宽的一列 */}
                <td className="col-wide" title={row.created_at}>
                  {String(row.created_at ?? '').slice(0, 16)}
                </td>
                <td className="col-third">{row.order_no}</td>
                <td className="col-third">{row.partner}</td>
                <td className="col-third">{row.species}</td>
                <td className="col-third">{row.grade || '—'}</td>
                <td
                  className="num col-third"
                  title={`厚度 ${row.thickness} mm × 宽度 ${row.width} mm`}
                >
                  {row.thickness}×{row.width}
                </td>
                <td className="num col-third">{row.length}</td>
                <td className="num col-third">{row.pieces}</td>
                <td className="num col-third">{row.bundles}</td>
                <td className="num col-third">{formatCubic(row.cubic)}</td>
                {money && (
                  <td className="num amount col-third">{formatAmount(row.unit_price)}</td>
                )}
                {money && (
                  <td className="num amount col-third">{formatAmount(row.amount)}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>

        {!loading && rows.length === 0 && (
          <EmptyState
            text="暂无记录"
            hint="这里按时间列出每一笔出入库明细，录单之后就有了"
            action={{ label: '去录入库单', to: '/inbound/new' }}
          />
        )}
        {loading && <TableSkeleton rows={6} cols={6} />}

        <Pager
          total={total}
          limit={PAGE_SIZE}
          offset={query.offset ?? 0}
          onChange={goPage}
          unit="条明细"
        />
      </div>
    </section>
  )
}
