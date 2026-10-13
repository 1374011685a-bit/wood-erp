import { useCallback, useEffect, useState } from 'react'
import {
  createContainer,
  createShipment,
  fetchBales,
  fetchContainers,
  fetchShipments,
  fetchShipmentContainers,
  type BaleRow,
  type ContainerRow,
  type ShipmentContainer,
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

export default function Bales() {
  const [containers, setContainers] = useState<ContainerRow[]>([])
  const [shipments, setShipments] = useState<ShipmentRow[]>([])
  const [activeShipment, setActiveShipment] = useState(0)
  const [shipmentBoxes, setShipmentBoxes] = useState<ShipmentContainer[]>([])
  const [rows, setRows] = useState<BaleRow[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const [input, setInput] = useState({ keyword: '', status: '' as '' | 'in_stock' | 'shipped' })
  const [activeContainer, setActiveContainer] = useState(0)
  const [reloadToken, setReloadToken] = useState(0)

  // 新建柜
  const [boxOpen, setBoxOpen] = useState(false)
  const [boxForm, setBoxForm] = useState({
    container_no: '',
    contract_no: '',
    bl_no: '',
    supplier: '',
    arrive_date: '',
    remark: '',
  })
  const [boxError, setBoxError] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(
    async (
      nextInput: typeof input,
      containerId: number,
      shipmentId: number,
      nextOffset: number,
    ) => {
      setLoading(true)
      try {
        const [shipmentPage, containerPage, balePage] = await Promise.all([
          fetchShipments({ limit: 50 }),
          fetchContainers({ limit: 50 }),
          fetchBales({
            keyword: nextInput.keyword.trim(),
            status: nextInput.status,
            container_id: containerId || undefined,
            shipment_id: shipmentId || undefined,
            limit: PAGE_SIZE,
            offset: nextOffset,
          }),
        ])
        setShipments(shipmentPage.rows)
        setContainers(containerPage.rows)
        setRows(balePage.rows)
        setTotal(balePage.total)

        if (shipmentId) {
          setShipmentBoxes(await fetchShipmentContainers(shipmentId))
        } else {
          setShipmentBoxes([])
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载失败')
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    void load(input, activeContainer, activeShipment, offset)
  }, [load, input, activeContainer, activeShipment, offset, reloadToken])

  const handleSearch = () =>
    setInput((prev) => ({ ...prev, keyword: prev.keyword.trim() }))

  const handleReset = () => {
    setInput({ keyword: '', status: '' })
    setActiveShipment(0)
    setActiveContainer(0)
    setOffset(0)
  }

  // 新建提单：一次把这票的柜号都填进去
  const [shipOpen, setShipOpen] = useState(false)
  const [shipForm, setShipForm] = useState({
    bl_no: '',
    contract_no: '',
    supplier: '',
    arrival_date: '',
    remark: '',
    container_nos: '',
  })
  const [shipError, setShipError] = useState('')
  const [shipSaving, setShipSaving] = useState(false)

  const submitShipment = async () => {
    if (!shipForm.bl_no.trim()) {
      setShipError('提单号不能为空')
      return
    }
    const containerNos = shipForm.container_nos
      .split(/[\s,，、;；]+/)
      .map((item) => item.trim())
      .filter(Boolean)
    if (containerNos.length === 0) {
      setShipError('请至少填一个柜号（一行一个）')
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
        container_nos: shipForm.container_nos,
      })
      setShipOpen(false)
      setShipForm({
        bl_no: '',
        contract_no: '',
        supplier: '',
        arrival_date: '',
        remark: '',
        container_nos: '',
      })
      setNotice(
        `已建提单 ${result.bl_no}，一次建了 ${result.containers.length} 个柜，去入库页按柜录包`,
      )
      setReloadToken((n) => n + 1)
    } catch (err) {
      setShipError(err instanceof Error ? err.message : '新建失败')
    } finally {
      setShipSaving(false)
    }
  }

  const submitBox = async () => {
    if (!boxForm.container_no.trim()) {
      setBoxError('柜号不能为空')
      return
    }
    setSaving(true)
    setBoxError('')
    try {
      const result = await createContainer({
        container_no: boxForm.container_no.trim(),
        contract_no: boxForm.contract_no.trim(),
        bl_no: boxForm.bl_no.trim(),
        supplier: boxForm.supplier.trim(),
        arrive_date: boxForm.arrive_date || undefined,
        remark: boxForm.remark.trim(),
      })
      setBoxOpen(false)
      setBoxForm({
        container_no: '',
        contract_no: '',
        bl_no: '',
        supplier: '',
        arrive_date: '',
        remark: '',
      })
      setNotice(`已新建柜 ${result.container_no}，去入库页把这柜的货入进来`)
      setReloadToken((n) => n + 1)
    } catch (err) {
      setBoxError(err instanceof Error ? err.message : '新建失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section>
      <PageHead
        title="码单"
        subtitle="一包一个码单：入库时按包数自动生成，出库时按码单发货"
        extra={
          <>
            <button className="btn" onClick={() => setBoxOpen(true)}>
              单独加柜
            </button>
            <button className="btn btn-primary" onClick={() => setShipOpen(true)}>
              新建提单（含柜）
            </button>
          </>
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

      {/* 柜概览：点一个柜就只看这柜的码单 */}
      <div className="card">
        <h2 className="section-title">提单（一票到货）</h2>
        {shipments.length === 0 ? (
          <EmptyState text="还没有提单，点右上角「新建提单（含柜）」开始" />
        ) : (
          <div className="box-grid">
            {shipments.map((ship) => (
              <button
                key={ship.id}
                type="button"
                className={
                  activeShipment === ship.id ? 'box-card is-active' : 'box-card'
                }
                onClick={() => {
                  setActiveShipment((prev) => (prev === ship.id ? 0 : ship.id))
                  setActiveContainer(0)
                  setOffset(0)
                }}
              >
                <span className="box-no">提单 {ship.bl_no}</span>
                <span className="box-line">合同 {ship.contract_no || '—'}</span>
                <span className="box-line">
                  到港 {ship.arrival_date} · {ship.supplier || '—'}
                </span>
                <span className="box-stats">
                  {ship.container_count} 个柜 · 共 {ship.bale_total} 包 · 在库{' '}
                  {ship.bale_in_stock}
                </span>
                <span className="box-line">
                  已录立方 {formatCubic(ship.bale_cubic)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h2 className="section-title">
          柜{activeShipment ? '（当前提单下的柜）' : '（一批到货）'}
        </h2>
        {activeShipment ? (
          shipmentBoxes.length === 0 ? (
            <EmptyState text="这张提单还没有柜" />
          ) : (
            <div className="box-grid">
              {shipmentBoxes.map((box) => (
                <button
                  key={box.id}
                  type="button"
                  className={
                    activeContainer === box.id ? 'box-card is-active' : 'box-card'
                  }
                  onClick={() =>
                    setActiveContainer((prev) => (prev === box.id ? 0 : box.id))
                  }
                >
                  <span className="box-no">{box.container_no}</span>
                  <span className="box-stats">
                    共 {box.bale_total} 包 · 在库 {box.bale_in_stock}
                  </span>
                </button>
              ))}
            </div>
          )
        ) : containers.length === 0 ? (
          <EmptyState text="还没有柜，点右上角「新建提单（含柜）」录入到货批次" />
        ) : (
          <div className="box-grid">
            {containers.map((box) => (
              <button
                key={box.id}
                type="button"
                className={
                  activeContainer === box.id ? 'box-card is-active' : 'box-card'
                }
                onClick={() =>
                  setActiveContainer((prev) => (prev === box.id ? 0 : box.id))
                }
              >
                <span className="box-no">{box.container_no}</span>
                <span className="box-line">
                  合同 {box.contract_no || '—'}
                </span>
                <span className="box-line">
                  到货 {box.arrive_date} · {box.supplier || '—'}
                </span>
                <span className="box-stats">
                  共 {box.bale_total} 包 · 在库 {box.bale_in_stock} · 已出{' '}
                  {box.bale_shipped}
                </span>
                <span className="box-line">
                  在库立方 {formatCubic(box.cubic_in_stock)}
                </span>
              </button>
            ))}
          </div>
        )}
        {activeContainer > 0 && (
          <p className="hint" style={{ marginTop: 12 }}>
            已筛选该柜的码单，再点一次柜卡片可以取消筛选。
          </p>
        )}
      </div>

      <div className="toolbar">
        <input
          className="input"
          placeholder="码单号 / 柜号 / 合同号"
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
            setActiveContainer(0)
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
        <select
          className="input"
          value={activeContainer}
          onChange={(event) => {
            setActiveContainer(Number(event.target.value))
            setOffset(0)
          }}
        >
          <option value={0}>全部柜</option>
          {containers.map((box) => (
            <option key={box.id} value={box.id}>
              {box.container_no}
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
              <th>码单号</th>
              <th>提单号</th>
              <th>柜号</th>
              <th>合同号</th>
              <th>品名</th>
              <th>等级</th>
              <th className="num">厚×宽×长</th>
              <th className="num">片数</th>
              <th className="num">立方</th>
              <th>状态</th>
              <th>出库单</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.bale_no}</td>
                <td>{row.bl_no || '—'}</td>
                <td>{row.container_no || '—'}</td>
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
              </tr>
            ))}
          </tbody>
        </table>

        {!loading && rows.length === 0 && (
          <EmptyState text="没有符合条件的码单" />
        )}
        {loading && <Loading />}

        <Pager
          total={total}
          limit={PAGE_SIZE}
          offset={offset}
          onChange={setOffset}
          unit="个码单"
        />
      </div>

      {shipOpen && (
        <div className="overlay" onClick={() => setShipOpen(false)}>
          <div
            className="modal modal-narrow modal-sheet"
            onClick={(event) => event.stopPropagation()}
          >
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
            <label className="field" style={{ marginTop: 14 }}>
              <span>合同号</span>
              <input
                className="input"
                placeholder="这张提单属于哪个合同"
                value={shipForm.contract_no}
                onChange={(event) =>
                  setShipForm((prev) => ({ ...prev, contract_no: event.target.value }))
                }
              />
            </label>
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
            <label className="field field-required" style={{ marginTop: 14 }}>
              <span>这一票的柜号（一行一个，可一次填完）</span>
              <textarea
                className="input textarea"
                rows={5}
                placeholder={'WH001\nWH002\nWH003'}
                value={shipForm.container_nos}
                onChange={(event) =>
                  setShipForm((prev) => ({ ...prev, container_nos: event.target.value }))
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

      {boxOpen && (
        <div className="overlay" onClick={() => setBoxOpen(false)}>
          <div
            className="modal modal-narrow modal-sheet"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <h2 className="modal-title">新建柜</h2>
              <button className="btn btn-sm btn-quiet" onClick={() => setBoxOpen(false)}>
                关闭
              </button>
            </div>

            <label className="field field-required">
              <span>柜号</span>
              <input
                className="input"
                placeholder="例如：WH2026-01"
                value={boxForm.container_no}
                onChange={(event) =>
                  setBoxForm((prev) => ({ ...prev, container_no: event.target.value }))
                }
              />
            </label>
            <label className="field" style={{ marginTop: 14 }}>
              <span>合同号</span>
              <input
                className="input"
                placeholder="整柜对应一个合同"
                value={boxForm.contract_no}
                onChange={(event) =>
                  setBoxForm((prev) => ({ ...prev, contract_no: event.target.value }))
                }
              />
            </label>
            <label className="field" style={{ marginTop: 14 }}>
              <span>提单号</span>
              <input
                className="input"
                placeholder="海运提单号"
                value={boxForm.bl_no}
                onChange={(event) =>
                  setBoxForm((prev) => ({ ...prev, bl_no: event.target.value }))
                }
              />
            </label>
            <label className="field" style={{ marginTop: 14 }}>
              <span>国外供应商</span>
              <input
                className="input"
                value={boxForm.supplier}
                onChange={(event) =>
                  setBoxForm((prev) => ({ ...prev, supplier: event.target.value }))
                }
              />
            </label>
            <label className="field" style={{ marginTop: 14 }}>
              <span>到货日期</span>
              <input
                className="input"
                type="date"
                value={boxForm.arrive_date}
                onChange={(event) =>
                  setBoxForm((prev) => ({ ...prev, arrive_date: event.target.value }))
                }
              />
            </label>
            <label className="field" style={{ marginTop: 14 }}>
              <span>备注</span>
              <input
                className="input"
                value={boxForm.remark}
                onChange={(event) =>
                  setBoxForm((prev) => ({ ...prev, remark: event.target.value }))
                }
              />
            </label>

            {boxError && <p className="login-error">{boxError}</p>}

            <div className="confirm-actions">
              <button className="btn" onClick={() => setBoxOpen(false)} disabled={saving}>
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void submitBox()}
                disabled={saving}
              >
                {saving ? '提交中…' : '确认'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
