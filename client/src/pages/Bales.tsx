import { useCallback, useEffect, useState } from 'react'
import {
  createContainer,
  fetchBales,
  fetchContainers,
  type BaleRow,
  type ContainerRow,
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
      nextOffset: number,
    ) => {
      setLoading(true)
      try {
        const [containerPage, balePage] = await Promise.all([
          fetchContainers({ limit: 50 }),
          fetchBales({
            keyword: nextInput.keyword.trim(),
            status: nextInput.status,
            container_id: containerId || undefined,
            limit: PAGE_SIZE,
            offset: nextOffset,
          }),
        ])
        setContainers(containerPage.rows)
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
    void load(input, activeContainer, offset)
  }, [load, input, activeContainer, offset, reloadToken])

  const handleSearch = () =>
    setInput((prev) => ({ ...prev, keyword: prev.keyword.trim() }))

  const handleReset = () => {
    setInput({ keyword: '', status: '' })
    setActiveContainer(0)
    setOffset(0)
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
          <button className="btn btn-primary" onClick={() => setBoxOpen(true)}>
            新建柜
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

      {/* 柜概览：点一个柜就只看这柜的码单 */}
      <div className="card">
        <h2 className="section-title">柜（一批到货）</h2>
        {containers.length === 0 ? (
          <EmptyState text="还没有柜，点右上角「新建柜」录入到货批次" />
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
