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

const typeLabel = (type: 'in' | 'out') => (type === 'in' ? '入库' : '出库')

const PAGE_SIZE = 50

export default function Records() {
  // 看不到金额的角色：单价 / 金额两列不渲染（后端也不返回这两个字段）
  const money = seesMoney(useRole())

  const [rows, setRows] = useState<RecordRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // 筛选条件（输入中的草稿）
  const [typeInput, setTypeInput] = useState<'' | 'in' | 'out'>('')
  const [speciesInput, setSpeciesInput] = useState('')
  const [partnerInput, setPartnerInput] = useState('')
  const [dateFromInput, setDateFromInput] = useState('')
  const [dateToInput, setDateToInput] = useState('')

  // 已生效的筛选条件
  const [query, setQuery] = useState<RecordQuery>({ limit: PAGE_SIZE, offset: 0 })

  const load = useCallback(async (next: RecordQuery) => {
    setLoading(true)
    setError('')
    try {
      const result = await fetchRecords(next)
      setRows(result.records)
      setTotal(result.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
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

      <div className="toolbar">
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
          placeholder="品名关键字"
          value={speciesInput}
          onChange={(event) => setSpeciesInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') handleSearch()
          }}
        />
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
        <button className="btn" onClick={handleSearch}>
          查询
        </button>
        <button className="btn" onClick={handleReset}>
          重置
        </button>
        <span className="spacer" />
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
                <td>
                  <span
                    className={
                      row.order_type === 'in' ? 'tag tag-in' : 'tag tag-out'
                    }
                  >
                    {typeLabel(row.order_type)}
                  </span>
                </td>
                {/* 时间只显示到分（秒挂在 title 上）：这一列原来是 159px，是流水表里最宽的一列 */}
                <td title={row.created_at}>{String(row.created_at ?? '').slice(0, 16)}</td>
                <td>{row.order_no}</td>
                <td>{row.partner}</td>
                <td>{row.species}</td>
                <td>{row.grade || '—'}</td>
                <td className="num" title={`厚度 ${row.thickness} mm × 宽度 ${row.width} mm`}>
                  {row.thickness}×{row.width}
                </td>
                <td className="num">{row.length}</td>
                <td className="num">{row.pieces}</td>
                <td className="num">{row.bundles}</td>
                <td className="num">{formatCubic(row.cubic)}</td>
                {money && (
                  <td className="num amount">{formatAmount(row.unit_price)}</td>
                )}
                {money && <td className="num amount">{formatAmount(row.amount)}</td>}
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
