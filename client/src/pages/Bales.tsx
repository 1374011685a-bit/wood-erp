import { useCallback, useEffect, useState } from 'react'
import {
  createShipment,
  deleteBale,
  deleteShipment,
  fetchBaleDetail,
  fetchBales,
  fetchContractOptions,
  fetchDict,
  fetchShipments,
  updateBale,
  type BaleItemLine,
  type BaleRow,
  type ContractOption,
  type DictAll,
  type ShipmentRow,
} from '../api'
import { EmptyState, Loading, PageHead, Pager, ToastHost } from '../components/Ui'

const PAGE_SIZE = 50

const roundTo = (value: number, digits: number) => Number(value.toFixed(digits))
const formatCubic = (value: number) => String(roundTo(value, 4))

const STATUS_TEXT: Record<BaleRow['status'], string> = {
  in_stock: '在库',
  shipped: '已出库',
}

/**
 * 采购入库明细：一包一行（包号 + 条码号）。
 * 按千木云的做法，提单直接管到包，中间不再有「柜」这一层。
 */
export default function Bales() {
  const [shipments, setShipments] = useState<ShipmentRow[]>([])
  const [contractOptions, setContractOptions] = useState<ContractOption[]>([])
  const [dict, setDict] = useState<DictAll>({ species: [], grade: [] })
  const [rows, setRows] = useState<BaleRow[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const [input, setInput] = useState({ keyword: '', status: '' as '' | 'in_stock' | 'shipped' })
  const [activeShipment, setActiveShipment] = useState(0)
  const [reloadToken, setReloadToken] = useState(0)

  // 新建提单
  const [shipOpen, setShipOpen] = useState(false)
  const [shipForm, setShipForm] = useState({
    bl_no: '',
    contract_no: '',
    supplier: '',
    arrival_date: '',
    remark: '',
  })
  const [shipError, setShipError] = useState('')
  const [shipSaving, setShipSaving] = useState(false)
  const [shipDeleteTarget, setShipDeleteTarget] = useState<ShipmentRow | null>(null)

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
  const [editLines, setEditLines] = useState<BaleItemLine[]>([])
  const [editError, setEditError] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [baleDeleteTarget, setBaleDeleteTarget] = useState<BaleRow | null>(null)

  const load = useCallback(
    async (nextInput: typeof input, shipmentId: number, nextOffset: number) => {
      setLoading(true)
      try {
        const [shipmentPage, balePage] = await Promise.all([
          fetchShipments({ limit: 50 }),
          fetchBales({
            keyword: nextInput.keyword.trim(),
            status: nextInput.status,
            shipment_id: shipmentId || undefined,
            limit: PAGE_SIZE,
            offset: nextOffset,
          }),
        ])
        setShipments(shipmentPage.rows)
        setRows(balePage.rows)
        setTotal(balePage.total)
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载失败')
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    void load(input, activeShipment, offset)
  }, [load, input, activeShipment, offset, reloadToken])

  useEffect(() => {
    void Promise.all([fetchContractOptions(), fetchDict()])
      .then(([contracts, dictData]) => {
        setContractOptions(contracts)
        setDict(dictData)
      })
      .catch(() => {
        // 拉不到不影响主流程
      })
  }, [reloadToken])

  const handleSearch = () =>
    setInput((prev) => ({ ...prev, keyword: prev.keyword.trim() }))

  const handleReset = () => {
    setInput({ keyword: '', status: '' })
    setActiveShipment(0)
    setOffset(0)
  }

  const submitShipment = async () => {
    if (!shipForm.bl_no.trim()) {
      setShipError('提单号不能为空')
      return
    }
    if (!shipForm.contract_no.trim()) {
      setShipError('请先选择合同：有了合同才有提单，也可以先去「采购合同」页新建合同')
      return
    }

    setShipSaving(true)
    setShipError('')
    try {
      const result = await createShipment({
        bl_no: shipForm.bl_no.trim(),
        contract_no: shipForm.contract_no.trim(),
        supplier: shipForm.supplier.trim(),
        arrival_date: shipForm.arrival_date || undefined,
        remark: shipForm.remark.trim(),
      })
      setShipOpen(false)
      setShipForm({ bl_no: '', contract_no: '', supplier: '', arrival_date: '', remark: '' })
      setNotice(`已建提单 ${result.bl_no}，去「采购入库」按包录货`)
      setReloadToken((n) => n + 1)
    } catch (err) {
      setShipError(err instanceof Error ? err.message : '新建失败')
    } finally {
      setShipSaving(false)
    }
  }

  const confirmShipDelete = async () => {
    if (!shipDeleteTarget) return
    try {
      await deleteShipment(shipDeleteTarget.id)
      setNotice(`已删除提单 ${shipDeleteTarget.bl_no}`)
      setShipDeleteTarget(null)
      setActiveShipment(0)
      setReloadToken((n) => n + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
      setShipDeleteTarget(null)
    }
  }

  const openBaleEdit = async (row: BaleRow) => {
    setError('')
    try {
      const detail = await fetchBaleDetail(row.id)
      setEditId(detail.id)
      setEditNo(detail.bale_no)
      setEditBarcode(detail.barcode)
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
      await updateBale(editId, {
        bale_no: editNo.trim(),
        items: items.map((line) => ({
          species: line.species.trim(),
          grade: (line.grade ?? '').trim(),
          thickness: Number(line.thickness),
          width: Number(line.width),
          length: Number(line.length),
          pieces: Number(line.pieces),
        })),
      })
      setEditOpen(false)
      setNotice(`已保存 ${editNo.trim()} 的规格，库存已同步`)
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
      setNotice(`已删除 ${baleDeleteTarget.barcode || baleDeleteTarget.bale_no}，库存已同步减少`)
      setBaleDeleteTarget(null)
      setReloadToken((n) => n + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
      setBaleDeleteTarget(null)
    }
  }

  return (
    <section>
      {/* 常用项候选：品名 / 等级可以直接选 */}
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
        subtitle="一包一张码单：包号是货上写的那个，条码号由系统生成（之后打印贴包上），出库按条码号发货"
        extra={
          <button className="btn btn-primary" onClick={() => setShipOpen(true)}>
            新建提单
          </button>
        }
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

      {/* 提单：点一张就只看这票的包 */}
      <div className="card">
        <h2 className="section-title">提单（一票到货）</h2>
        {shipments.length === 0 ? (
          <EmptyState text="还没有提单，点右上角「新建提单」开始" />
        ) : (
          <div className="box-grid">
            {shipments.map((ship) => (
              <div
                key={ship.id}
                className={activeShipment === ship.id ? 'box-card is-active' : 'box-card'}
              >
                <button
                  type="button"
                  className="box-main"
                  onClick={() => {
                    setActiveShipment((prev) => (prev === ship.id ? 0 : ship.id))
                    setOffset(0)
                  }}
                >
                  <span className="box-no">提单 {ship.bl_no}</span>
                  <span className="box-line">合同 {ship.contract_no || '—'}</span>
                  <span className="box-line">
                    到港 {ship.arrival_date || '—'} · {ship.supplier || '—'}
                  </span>
                  <span className="box-stats">
                    共 {ship.bale_total} 包 · 在库 {ship.bale_in_stock}
                  </span>
                  <span className="box-line">已录立方 {formatCubic(ship.bale_cubic)}</span>
                </button>
                <button
                  type="button"
                  className="box-del"
                  title="删除这张提单（在库的包要先出完或删掉）"
                  onClick={() => setShipDeleteTarget(ship)}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        )}
        {activeShipment > 0 && (
          <p className="hint" style={{ marginTop: 12 }}>
            已筛选这张提单的包，再点一次卡片可以取消筛选。
          </p>
        )}
      </div>

      <div className="toolbar">
        <input
          className="input"
          placeholder="包号 / 条码号 / 提单号 / 合同号"
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
          <option value="in_stock">在库</option>
          <option value="shipped">已出库</option>
        </select>
        <select
          className="input"
          value={activeShipment}
          onChange={(event) => {
            setActiveShipment(Number(event.target.value))
            setOffset(0)
          }}
        >
          <option value={0}>全部提单</option>
          {shipments.map((ship) => (
            <option key={ship.id} value={ship.id}>
              {ship.bl_no}
            </option>
          ))}
        </select>
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
              <th>包号</th>
              <th>条码号</th>
              <th>提单号</th>
              <th>合同号</th>
              <th>品名</th>
              <th>等级</th>
              <th className="num">厚×宽×长</th>
              <th className="num">片数</th>
              <th className="num">立方</th>
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
                <span>条码号（系统生成，打印贴包上用）</span>
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
                  <th className="num">厚度mm</th>
                  <th className="num">宽度mm</th>
                  <th className="num">长度m</th>
                  <th className="num">片数</th>
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

      {shipDeleteTarget && (
        <div className="overlay" onClick={() => setShipDeleteTarget(null)}>
          <div
            className="modal modal-narrow modal-alert"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="modal-title">删除提单</h2>
            <p className="confirm-text">
              确认删除提单 {shipDeleteTarget.bl_no}？这张提单下面还有在库的包时不能删，
              已经全部出完才能删。
            </p>
            <div className="confirm-actions">
              <button className="btn" onClick={() => setShipDeleteTarget(null)}>
                取消
              </button>
              <button className="btn btn-danger-solid" onClick={() => void confirmShipDelete()}>
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}

      {shipOpen && (
        <div className="overlay" onClick={() => setShipOpen(false)}>
          <div className="modal modal-narrow modal-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h2 className="modal-title">新建提单</h2>
              <button className="btn btn-sm btn-quiet" onClick={() => setShipOpen(false)}>
                关闭
              </button>
            </div>

            <label className="field field-required">
              <span>提单号</span>
              <input
                className="input"
                placeholder="例如：MBL-2026-0001"
                value={shipForm.bl_no}
                onChange={(event) =>
                  setShipForm((prev) => ({ ...prev, bl_no: event.target.value }))
                }
              />
            </label>
            <label className="field field-required" style={{ marginTop: 14 }}>
              <span>合同号</span>
              <select
                className="input"
                value={shipForm.contract_no}
                onChange={(event) => {
                  const no = event.target.value
                  const hit = contractOptions.find((item) => item.contract_no === no)
                  setShipForm((prev) => ({
                    ...prev,
                    contract_no: no,
                    supplier: prev.supplier.trim() ? prev.supplier : hit?.partner ?? '',
                  }))
                }}
              >
                <option value="">请选择合同…</option>
                {contractOptions.map((option) => (
                  <option key={option.id} value={option.contract_no}>
                    {option.contract_no}
                    {[option.title, option.partner].filter(Boolean).length > 0
                      ? ` · ${[option.title, option.partner].filter(Boolean).join(' · ')}`
                      : ''}
                  </option>
                ))}
              </select>
            </label>
            <p className="hint">
              {contractOptions.length === 0
                ? '系统里还没有合同：请先到「采购合同」页新建合同，再回来建提单。'
                : '先有合同才有提单，这里只能选已建档的合同号。'}
            </p>
            <label className="field" style={{ marginTop: 14 }}>
              <span>国外供应商</span>
              <input
                className="input"
                value={shipForm.supplier}
                onChange={(event) =>
                  setShipForm((prev) => ({ ...prev, supplier: event.target.value }))
                }
              />
            </label>
            <label className="field" style={{ marginTop: 14 }}>
              <span>到港日期</span>
              <input
                className="input"
                type="date"
                value={shipForm.arrival_date}
                onChange={(event) =>
                  setShipForm((prev) => ({ ...prev, arrival_date: event.target.value }))
                }
              />
            </label>
            <label className="field" style={{ marginTop: 14 }}>
              <span>备注</span>
              <input
                className="input"
                value={shipForm.remark}
                onChange={(event) =>
                  setShipForm((prev) => ({ ...prev, remark: event.target.value }))
                }
              />
            </label>

            {shipError && <p className="login-error">{shipError}</p>}

            <div className="confirm-actions">
              <button className="btn" onClick={() => setShipOpen(false)} disabled={shipSaving}>
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void submitShipment()}
                disabled={shipSaving}
              >
                {shipSaving ? '提交中…' : '确认'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
