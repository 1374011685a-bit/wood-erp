import { useCallback, useEffect, useState } from 'react'
import {
  deleteBale,
  fetchBaleDetail,
  fetchBales,
  fetchContractPicker,
  fetchDict,
  updateBale,
  type BaleItemLine,
  type BaleRow,
  type ContractPickerRow,
  type DictAll,
} from '../api'
import { EmptyState, Loading, PageHead, Pager, ToastHost } from '../components/Ui'
import { roundTo, formatCubic } from '../utils/num'

const PAGE_SIZE = 50

const STATUS_TEXT: Record<BaleRow['status'], string> = {
  in_stock: '在库',
  shipped: '已出库',
}

/**
 * 采购入库明细：专门用来看和查的页面。
 * 上半部分是「合同到货进度」（合同多少方、入了多少、还差多少方），
 * 下半部分是一包一行的明细，点进度表的某一行就直接筛这张合同。
 */
export default function Bales() {
  const [rows, setRows] = useState<BaleRow[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const [progress, setProgress] = useState<ContractPickerRow[]>([])
  const [progressLoading, setProgressLoading] = useState(false)

  const [input, setInput] = useState({
    keyword: '',
    status: '' as '' | 'in_stock' | 'shipped',
    contract_no: '',
  })
  const [filters, setFilters] = useState({ keyword: '', status: '' as '' | 'in_stock' | 'shipped' })
  const [reloadToken, setReloadToken] = useState(0)
  const [dict, setDict] = useState<DictAll>({ species: [], grade: [] })

  // 编辑码单
  const emptyLine = (): BaleItemLine => ({
    species: '',
    grade: '',
    thickness: 0,
    width: 0,
    length: 0,
    pieces: 1,
    cubic: 0,
  })
  const [editOpen, setEditOpen] = useState(false)
  const [editId, setEditId] = useState(0)
  const [editNo, setEditNo] = useState('')
  const [editBarcode, setEditBarcode] = useState('')
  const [editBoxNo, setEditBoxNo] = useState('')
  const [editLines, setEditLines] = useState<BaleItemLine[]>([])
  const [editError, setEditError] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [baleDeleteTarget, setBaleDeleteTarget] = useState<BaleRow | null>(null)

  const load = useCallback(
    async (
      nextFilters: typeof filters,
      contractNo: string,
      nextOffset: number,
    ) => {
      setLoading(true)
      try {
        const page = await fetchBales({
          keyword:
            [nextFilters.keyword.trim(), contractNo].filter(Boolean).join(' ') || undefined,
          status: nextFilters.status,
          limit: PAGE_SIZE,
          offset: nextOffset,
        })
        setRows(page.rows)
        setTotal(page.total)
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载失败')
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  const loadProgress = useCallback(async () => {
    setProgressLoading(true)
    try {
      const page = await fetchContractPicker({ limit: 100 })
      setProgress(page.rows)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载合同进度失败')
    } finally {
      setProgressLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(filters, input.contract_no, offset)
  }, [load, filters, input.contract_no, offset, reloadToken])

  useEffect(() => {
    void loadProgress()
  }, [loadProgress, reloadToken])

  useEffect(() => {
    void fetchDict()
      .then(setDict)
      .catch(() => {
        // 拉不到就退化成手填
      })
  }, [])

  const handleSearch = () => {
    setOffset(0)
    setFilters({ keyword: input.keyword.trim(), status: input.status })
  }

  const handleReset = () => {
    setInput({ keyword: '', status: '', contract_no: '' })
    setFilters({ keyword: '', status: '' })
    setOffset(0)
  }

  const openBaleEdit = async (row: BaleRow) => {
    setError('')
    try {
      const detail = await fetchBaleDetail(row.id)
      setEditId(detail.id)
      setEditNo(detail.bale_no)
      setEditBarcode(detail.barcode)
      setEditBoxNo(detail.box_no ?? '')
      setEditLines(detail.items.length > 0 ? detail.items : [emptyLine()])
      setEditError('')
      setEditOpen(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : '打开失败')
    }
  }

  const submitBaleEdit = async () => {
    if (!editNo.trim()) {
      setEditError('包号不能为空')
      return
    }
    const items = editLines.filter((line) => line.species.trim())
    if (items.length === 0) {
      setEditError('至少要有一个规格（品名必填）')
      return
    }

    setEditSaving(true)
    setEditError('')
    try {
      const result = await updateBale(editId, {
        bale_no: editNo.trim(),
        box_no: editBoxNo.trim(),
        items: items.map((line) => ({
          species: line.species.trim(),
          grade: (line.grade ?? '').trim(),
          thickness: Number(line.thickness),
          width: Number(line.width),
          length: Number(line.length),
          pieces: Number(line.pieces),
          // 原样把这一行原来的单价带回去，后端就不会拿「最近入库价」重算金额
          unit_price: line.unit_price ?? 0,
        })),
      })
      setEditOpen(false)
      if (result.amount_changed) {
        // 财务字段变了就必须让用户看见
        setError(
          `注意：这次保存后这一包对应的入库金额变了：${result.amount_before} → ${result.amount_after} 元，` +
            `请核对是不是自己改了单价（立方和单价都没动的话不会变）。`,
        )
      } else {
        setNotice(`已保存包号 ${editNo.trim()}，库存与金额都没变`)
      }
      setReloadToken((n) => n + 1)
    } catch (err) {
      setEditError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setEditSaving(false)
    }
  }

  const confirmBaleDelete = async () => {
    if (!baleDeleteTarget) return
    try {
      await deleteBale(baleDeleteTarget.id)
      setNotice(
        `已删除 ${baleDeleteTarget.barcode || baleDeleteTarget.bale_no}，库存已同步减少`,
      )
      setBaleDeleteTarget(null)
      setReloadToken((n) => n + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
      setBaleDeleteTarget(null)
    }
  }

  const inStockRows = rows.filter((row) => row.status === 'in_stock')
  const pageCubic = roundTo(
    rows.reduce((sum, row) => sum + (row.cubic ?? 0), 0),
    4,
  )
  const inStockCubic = roundTo(
    inStockRows.reduce((sum, row) => sum + (row.cubic ?? 0), 0),
    4,
  )
  const leftTotal = roundTo(
    progress.reduce((sum, row) => sum + (row.left_cubic ?? 0), 0),
    4,
  )

  return (
    <section>
      <datalist id="dict-species">
        {dict.species.map((item) => (
          <option key={item.id} value={item.name} />
        ))}
      </datalist>
      <datalist id="dict-grade">
        {dict.grade.map((item) => (
          <option key={item.id} value={item.name} />
        ))}
      </datalist>

      <PageHead
        title="采购入库明细"
        subtitle="看货的地方：上面盯合同还差多少方没到，下面一包一行查每一包的状态（提单在「采购入库」里录）"
      />

      <ToastHost
        items={[
          notice
            ? {
                id: 'bale-notice',
                kind: 'success' as const,
                message: notice,
                onClose: () => setNotice(''),
              }
            : null,
          error
            ? {
                id: 'bale-error',
                kind: 'error' as const,
                message: error,
                onClose: () => setError(''),
              }
            : null,
        ]}
      />

      {/* 合同到货进度：合同多少方、入了多少、还差多少方 */}
      <div className="card">
        <h2 className="section-title">合同到货进度（立方）</h2>
        {progress.length === 0 && !progressLoading ? (
          <EmptyState text="还没有合同，先去「采购合同」建一份" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>合同号</th>
                <th>供应商</th>
                <th>品名</th>
                <th className="num">合同立方 (m³)</th>
                <th className="num">已入库 (m³)</th>
                <th className="num">未到货 (m³)</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {progress.map((row) => (
                <tr
                  key={row.id}
                  className={input.contract_no === row.contract_no ? 'row-active' : undefined}
                  onClick={() => {
                    const next = input.contract_no === row.contract_no ? '' : row.contract_no
                    setInput((prev) => ({ ...prev, contract_no: next }))
                    setOffset(0)
                  }}
                  title="点一下只看这张合同的包"
                >
                  <td>{row.contract_no}</td>
                  <td>{row.partner || '—'}</td>
                  <td>{row.species_text || '—'}</td>
                  <td className="num">{formatCubic(row.total_qty)}</td>
                  <td className="num">{formatCubic(row.in_cubic)}</td>
                  <td className="num">{formatCubic(row.left_cubic)}</td>
                  <td>
                    <span className={row.status === '全部发货' ? 'tag tag-in' : 'tag tag-out'}>
                      {row.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5} className="sheet-total-label">
                  合计（未到货）
                </td>
                <td className="num">{formatCubic(leftTotal)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        )}
        {progressLoading && <Loading />}
        {input.contract_no && (
          <p className="hint" style={{ marginTop: 12 }}>
            已按合同 {input.contract_no} 筛选下面的包，再点一次那一行可以取消。
          </p>
        )}
      </div>

      {/* 包明细 */}
      <div className="toolbar">
        <input
          className="input"
          placeholder="包号 / 条码号 / 柜号 / 提单号 / 合同号"
          value={input.keyword}
          onChange={(event) => setInput((prev) => ({ ...prev, keyword: event.target.value }))}
          onKeyDown={(event) => {
            if (event.key === 'Enter') handleSearch()
          }}
        />
        <select
          className="input"
          value={input.status}
          onChange={(event) =>
            setInput((prev) => ({
              ...prev,
              status: event.target.value as '' | 'in_stock' | 'shipped',
            }))
          }
        >
          <option value="">全部状态</option>
          <option value="in_stock">只看在库</option>
          <option value="shipped">只看已出库</option>
        </select>
        <button className="btn" onClick={handleSearch}>
          查询
        </button>
        <button className="btn" onClick={handleReset}>
          重置
        </button>
        <span className="spacer" />
        <span className="muted">
          共 {total} 包 · 本页在库 {inStockRows.length} 包 · 在库 {formatCubic(inStockCubic)} m³ ·
          本页合计 {formatCubic(pageCubic)} m³
        </span>
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>包号</th>
              <th>条码号</th>
              <th>柜号</th>
              <th>提单码</th>
              <th>合同号</th>
              <th>品名</th>
              <th>等级</th>
              <th className="num">厚×宽×长 (mm×mm×m)</th>
              <th className="num">片数 (片)</th>
              <th className="num">立方 (m³)</th>
              <th>状态</th>
              <th>出库单</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.bale_no || '—'}</td>
                <td>{row.barcode || '—'}</td>
                <td>{row.box_no || '—'}</td>
                <td>{row.bl_no || '—'}</td>
                <td>{row.contract_no || '—'}</td>
                <td>{row.species}</td>
                <td>{row.grade || '—'}</td>
                <td className="num">
                  {row.thickness}×{row.width}×{row.length}
                </td>
                <td className="num">{row.pieces}</td>
                <td className="num">{formatCubic(row.cubic)}</td>
                <td>
                  <span className={row.status === 'in_stock' ? 'tag tag-in' : 'tag tag-out'}>
                    {STATUS_TEXT[row.status]}
                  </span>
                </td>
                <td>{row.outbound_order_no || '—'}</td>
                <td>
                  <div className="row-actions">
                    <button className="btn btn-sm" onClick={() => void openBaleEdit(row)}>
                      编辑
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => setBaleDeleteTarget(row)}
                    >
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {!loading && rows.length === 0 && <EmptyState text="没有符合条件的包" />}
        {loading && <Loading />}

        <Pager
          total={total}
          limit={PAGE_SIZE}
          offset={offset}
          onChange={setOffset}
          unit="个包"
        />
      </div>

      {editOpen && (
        <div className="overlay" onClick={() => setEditOpen(false)}>
          <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h2 className="modal-title">编辑这一包</h2>
              <button className="btn btn-sm btn-quiet" onClick={() => setEditOpen(false)}>
                关闭
              </button>
            </div>

            <div className="field-row">
              <label className="field field-required">
                <span>包号（货上写的那个）</span>
                <input
                  className="input"
                  value={editNo}
                  onChange={(event) => setEditNo(event.target.value)}
                />
              </label>
              <label className="field">
                <span>柜号</span>
                <input
                  className="input"
                  value={editBoxNo}
                  onChange={(event) => setEditBoxNo(event.target.value)}
                />
              </label>
              <label className="field">
                <span>条码号（系统生成）</span>
                <input className="input" value={editBarcode} readOnly />
              </label>
            </div>

            <p className="hint" style={{ marginTop: 14 }}>
              这包里的规格（可以多个）；改完入库明细会同步调整，库存跟着变。
            </p>

            <table className="table table-detail">
              <thead>
                <tr>
                  <th>品名</th>
                  <th>等级</th>
                  <th className="num">厚度 (mm)</th>
                  <th className="num">宽度 (mm)</th>
                  <th className="num">长度 (m)</th>
                  <th className="num">片数 (片)</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {editLines.map((line, index) => (
                  <tr key={index}>
                    {(['species', 'grade', 'thickness', 'width', 'length', 'pieces'] as const).map(
                      (field) => (
                        <td key={field}>
                          <input
                            className="input input-cell"
                            inputMode={
                              field === 'species' || field === 'grade' ? undefined : 'decimal'
                            }
                            list={
                              field === 'species'
                                ? 'dict-species'
                                : field === 'grade'
                                  ? 'dict-grade'
                                  : undefined
                            }
                            value={String(line[field] === 0 ? '' : line[field])}
                            onChange={(event) =>
                              setEditLines((prev) =>
                                prev.map((item, i) =>
                                  i === index
                                    ? {
                                        ...item,
                                        [field]:
                                          field === 'species' || field === 'grade'
                                            ? event.target.value
                                            : Number(event.target.value),
                                      }
                                    : item,
                                ),
                              )
                            }
                          />
                        </td>
                      ),
                    )}
                    <td>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() =>
                          setEditLines((prev) =>
                            prev.length > 1 ? prev.filter((_, i) => i !== index) : prev,
                          )
                        }
                        disabled={editLines.length === 1}
                      >
                        删一行
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="row-tools">
              <button className="btn" onClick={() => setEditLines((prev) => [...prev, emptyLine()])}>
                + 加一个规格
              </button>
            </div>

            {editError && <p className="login-error">{editError}</p>}

            <div className="confirm-actions">
              <button className="btn" onClick={() => setEditOpen(false)} disabled={editSaving}>
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void submitBaleEdit()}
                disabled={editSaving}
              >
                {editSaving ? '提交中…' : '确认'}
              </button>
            </div>
          </div>
        </div>
      )}

      {baleDeleteTarget && (
        <div className="overlay" onClick={() => setBaleDeleteTarget(null)}>
          <div
            className="modal modal-narrow modal-alert"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="modal-title">删除这一包</h2>
            <p className="confirm-text">
              确认删除 {baleDeleteTarget.barcode || baleDeleteTarget.bale_no}？这一包的库存会一起减掉，
              此操作不可恢复。
            </p>
            <div className="confirm-actions">
              <button className="btn" onClick={() => setBaleDeleteTarget(null)}>
                取消
              </button>
              <button className="btn btn-danger-solid" onClick={() => void confirmBaleDelete()}>
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
