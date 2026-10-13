import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  downloadFile,
  fetchStockList,
  stockExportUrl,
  type StockRow,
} from '../api'
import {
  EmptyState,
  Loading,
  PageHead,
  ToastHost,
} from '../components/Ui'
import { roundTo, formatCubic } from '../utils/num'

const formatPrice = (value: number | null) =>
  value === null ? '—' : value.toFixed(2)

export default function Stock() {
  const [rows, setRows] = useState<StockRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [speciesInput, setSpeciesInput] = useState('')
  const [appliedSpecies, setAppliedSpecies] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportHint, setExportHint] = useState('')

  const load = useCallback(async (species: string) => {
    setLoading(true)
    setError('')
    try {
      setRows(await fetchStockList(species))
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(appliedSpecies)
  }, [load, appliedSpecies])

  const totalCubic = useMemo(
    () => roundTo(rows.reduce((sum, row) => sum + row.total_cubic, 0), 4),
    [rows],
  )

  const handleSearch = () => setAppliedSpecies(speciesInput.trim())

  const handleReset = () => {
    setSpeciesInput('')
    setAppliedSpecies('')
  }

  const handleExport = async () => {
    if (rows.length === 0) {
      setExportHint('当前没有可导出的数据')
      return
    }
    setExporting(true)
    try {
      await downloadFile(stockExportUrl(appliedSpecies), '库存表.xlsx')
    } catch (err) {
      setExportHint(err instanceof Error ? err.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  return (
    <section>
      <PageHead
        title="库存"
        subtitle="按品名、等级、尺寸归组的实时库存，数据由出入库明细直接汇总"
        extra={
          <button
            className="btn"
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? '导出中…' : '导出 Excel'}
          </button>
        }
      />

      <ToastHost
        items={[
          exportHint
            ? {
                id: 'stock-export-hint',
                kind: 'info' as const,
                message: exportHint,
                onClose: () => setExportHint(''),
              }
            : null,
          error
            ? {
                id: 'stock-error',
                kind: 'error' as const,
                message: error,
                onClose: () => setError(''),
              }
            : null,
        ]}
      />

      <div className="toolbar">
        <input
          className="input"
          placeholder="品名关键字"
          value={speciesInput}
          onChange={(event) => setSpeciesInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') handleSearch()
          }}
        />
        <button className="btn" onClick={handleSearch}>
          查询
        </button>
        <button className="btn" onClick={handleReset}>
          重置
        </button>
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>品名</th>
              <th>等级</th>
              <th className="num">厚度(mm)</th>
              <th className="num">宽度(mm)</th>
              <th className="num">长度(m)</th>
              <th className="num">当前件数</th>
              <th className="num">当前片数</th>
              <th className="num">当前立方</th>
              <th className="num">最近入库单价</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={[row.species, row.grade, row.thickness, row.width, row.length].join('|')}>
                <td>{row.species}</td>
                <td>{row.grade || '—'}</td>
                <td className="num">{row.thickness}</td>
                <td className="num">{row.width}</td>
                <td className="num">{row.length}</td>
                <td className="num">{row.total_bundles}</td>
                <td className="num">{row.total_pieces}</td>
                <td className="num">{formatCubic(row.total_cubic)}</td>
                <td className="num amount">{formatPrice(row.last_unit_price)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {!loading && rows.length === 0 && (
          <EmptyState text="没有符合条件的库存规格" />
        )}
        {loading && <Loading />}

        <div className="totals">
          <span>当前共 {rows.length} 个规格</span>
          <span>合计立方：{formatCubic(totalCubic)}</span>
        </div>
      </div>
    </section>
  )
}
