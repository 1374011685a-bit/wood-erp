import { useCallback, useEffect, useState } from 'react'
import {
  fetchRecycleList,
  purgeRecycleOrder,
  restoreRecycleOrder,
  type RecycleRow,
} from '../api'
import { EmptyState, PageHead, TableSkeleton, ToastHost } from '../components/Ui'
import { formatCubic, formatAmount } from '../utils/num'
import { useRole } from '../hooks/useRole'
import { seesMoney } from '../permissions'

const typeLabel = (type: RecycleRow['type']) =>
  type === 'in' ? '入库' : type === 'out' ? '出库' : '合同'

/** 各种类型在文案里怎么说（「恢复入库单 X」/「彻底删除合同 X」） */
const orderWord = (type: RecycleRow['type']) =>
  type === 'in' ? '入库单' : type === 'out' ? '出库单' : '合同'

const tagClass = (type: RecycleRow['type']) =>
  type === 'in' ? 'tag tag-in' : type === 'out' ? 'tag tag-out' : 'tag tag-contract'

export default function Recycle() {
  // 看不到金额的角色：金额列不渲染（后端也不返回 total_amount）
  const money = seesMoney(useRole())

  const [rows, setRows] = useState<RecycleRow[]>([])
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [purgeTarget, setPurgeTarget] = useState<RecycleRow | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setRows(await fetchRecycleList())
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const handleRestore = async (row: RecycleRow) => {
    setBusy(`${row.type}-${row.id}`)
    setError('')
    try {
      await restoreRecycleOrder(row.type, row.id)
      setNotice(`已恢复${orderWord(row.type)} ${row.order_no}`)
      await load()
    } catch (err) {
      // 恢复出库单可能因为库存不够被拦，后端原文展示
      setError(err instanceof Error ? err.message : '恢复失败')
    } finally {
      setBusy('')
    }
  }

  const confirmPurge = async () => {
    if (!purgeTarget) return
    setBusy(`${purgeTarget.type}-${purgeTarget.id}`)
    setError('')
    try {
      await purgeRecycleOrder(purgeTarget.type, purgeTarget.id)
      setNotice(`已彻底删除 ${purgeTarget.order_no}`)
      setPurgeTarget(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
      setPurgeTarget(null)
    } finally {
      setBusy('')
    }
  }

  return (
    <section>
      <PageHead
        title="回收站"
        subtitle="删除的单据会先放到这里，库存已经同步扣减；可以整单恢复，也可以彻底删除"
        extra={
          <button className="btn" onClick={() => void load()} disabled={loading}>
            刷新
          </button>
        }
      />

      <ToastHost
        items={[
          notice
            ? {
                id: 'recycle-notice',
                kind: 'success' as const,
                message: notice,
                onClose: () => setNotice(''),
              }
            : null,
          error
            ? {
                id: 'recycle-error',
                kind: 'error' as const,
                message: error,
                onClose: () => setError(''),
              }
            : null,
        ]}
      />

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>类型</th>
              <th>单号</th>
              <th>供应商/客户</th>
              <th>单据日期</th>
              <th className="num">立方</th>
              {money && <th className="num">金额</th>}
              <th className="num">明细数</th>
              <th>删除时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.type}-${row.id}`}>
                <td>
                  <span className={tagClass(row.type)}>
                    {typeLabel(row.type)}
                  </span>
                </td>
                <td>{row.order_no}</td>
                <td>{row.partner || '—'}</td>
                <td>{row.order_date}</td>
                <td className="num">{formatCubic(row.total_cubic)}</td>
                {money && (
                  <td className="num amount">{formatAmount(row.total_amount)}</td>
                )}
                {/* 合同那条：这里是这张合同下的入库单张数，不是明细行数 */}
                <td className="num">
                  {row.type === 'contract' ? `${row.item_count} 张入库单` : row.item_count}
                </td>
                <td>{row.deleted_at}</td>
                <td>
                  <div className="row-actions">
                    <button
                      className="btn btn-sm"
                      onClick={() => void handleRestore(row)}
                      disabled={busy === `${row.type}-${row.id}`}
                    >
                      恢复
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => setPurgeTarget(row)}
                    >
                      彻底删除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {!loading && rows.length === 0 && (
          <EmptyState
            text="回收站是空的"
            hint="删掉的单据会先放到这里，库存已经同步扣减，可以整单恢复"
          />
        )}
        {loading && <TableSkeleton rows={4} cols={5} />}

        <div className="totals">
          <span>共 {rows.length} 条已删除单据</span>
        </div>
      </div>

      {purgeTarget && (
        <div className="overlay" onClick={() => setPurgeTarget(null)}>
          <div
            className="modal modal-narrow modal-alert"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="modal-title">彻底删除</h2>
            <p className="confirm-text">
              确认彻底删除{orderWord(purgeTarget.type)} {purgeTarget.order_no}？
              {purgeTarget.type === 'contract'
                ? '它下面的提单、入库单、明细、包会一起物理删掉，合同文件也会删掉，' +
                  '此操作不可恢复。'
                : '明细会一起删掉，此操作不可恢复。'}
            </p>
            <div className="confirm-actions">
              <button
                className="btn"
                onClick={() => setPurgeTarget(null)}
                disabled={busy !== ''}
              >
                取消
              </button>
              <button
                className="btn btn-danger-solid"
                onClick={() => void confirmPurge()}
                disabled={busy !== ''}
              >
                {busy ? '删除中…' : '彻底删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
