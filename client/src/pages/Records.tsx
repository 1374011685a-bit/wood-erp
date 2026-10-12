import { useCallback, useEffect, useState } from 'react'
import { fetchRecords, type RecordQuery, type RecordRow } from '../api'
import {
  EmptyState,
  Loading,
  PageHead,
  ToastHost,
} from '../components/Ui'

const roundTo = (value: number, digits: number) => Number(value.toFixed(digits))

// 立方去掉末尾零（12.996），金额/单价固定两位
const formatCubic = (value: number) => String(roundTo(value, 4))
const formatAmount = (value: number) => value.toFixed(2)

const typeLabel = (type: 'in' | 'out') => (type === 'in' ? '入库' : '出库')

export default function Records() {
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
  const [query, setQuery] = useState<RecordQuery>({})

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
    })

  const handleReset = () => {
    setTypeInput('')
    setSpeciesInput('')
    setPartnerInput('')
    setDateFromInput('')
    setDateToInput('')
    setQuery({})
  }

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
        <table className="table">
          <thead>
            <tr>
              <th>类型</th>
              <th>时间</th>
              <th>单号</th>
              <th>供应商/客户</th>
              <th>品名</th>
              <th>等级</th>
              <th className="num">厚×宽×长</th>
              <th className="num">片数</th>
              <th className="num">件数</th>
              <th className="num">立方</th>
              <th className="num">单价</th>
              <th className="num">金额</th>
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
                <td>{row.created_at}</td>
                <td>{row.order_no}</td>
                <td>{row.partner}</td>
                <td>{row.species}</td>
                <td>{row.grade || '—'}</td>
                <td className="num">
                  {row.thickness}×{row.width}×{row.length}
                </td>
                <td className="num">{row.pieces}</td>
                <td className="num">{row.bundles}</td>
                <td className="num">{formatCubic(row.cubic)}</td>
                <td className="num amount">{formatAmount(row.unit_price)}</td>
                <td className="num amount">{formatAmount(row.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {!loading && rows.length === 0 && <EmptyState text="暂无记录" />}
        {loading && <Loading />}
      </div>
    </section>
  )
}
