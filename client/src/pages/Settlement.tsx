import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createPayment,
  deletePayment,
  downloadFile,
  fetchPayments,
  fetchSettlementSummary,
  fetchStatement,
  statementExportUrl,
  type PaymentQuery,
  type PaymentRow,
  type SettlementSide,
  type SettlementSummary,
  type Statement,
} from '../api'
import {
  EmptyState,
  Loading,
  PageHead,
  Pager,
  TableSkeleton,
  ToastHost,
} from '../components/Ui'
import { formatCubic, formatAmount, todayLocal } from '../utils/num'

const PAGE_SIZE = 20

const pad = (value: number) => String(value).padStart(2, '0')

/** 本月 1 号：对账默认看当月 */
function monthStart() {
  const now = new Date()
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`
}

const SIDE_TEXT: Record<SettlementSide, { label: string; money: string; side: string }> = {
  customer: { label: '客户', money: '收款', side: '应收' },
  supplier: { label: '供应商', money: '付款', side: '应付' },
}

const emptyPaymentForm = () => ({
  partner: '',
  amount: '',
  pay_date: todayLocal(),
  method: '',
  remark: '',
})

export default function Settlement() {
  const [side, setSide] = useState<SettlementSide>('customer')
  const [summary, setSummary] = useState<SettlementSummary | null>(null)
  const [payments, setPayments] = useState<PaymentRow[]>([])
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  // 对账单弹层
  const [statement, setStatement] = useState<Statement | null>(null)
  const [statementPartner, setStatementPartner] = useState('')
  const [period, setPeriod] = useState({ from: monthStart(), to: todayLocal() })
  const [statementLoading, setStatementLoading] = useState(false)
  const [exporting, setExporting] = useState(false)

  // 新增收付款弹层
  const [paymentOpen, setPaymentOpen] = useState(false)
  const [paymentForm, setPaymentForm] = useState(emptyPaymentForm)
  const [paymentError, setPaymentError] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<PaymentRow | null>(null)
  const [deleting, setDeleting] = useState(false)

  // 收付款记录的筛选与分页
  const [paymentInput, setPaymentInput] = useState({
    payment_no: '',
    partner: '',
    method: '',
    date_from: '',
    date_to: '',
  })
  const [paymentFilters, setPaymentFilters] = useState<PaymentQuery>({ side: 'customer' })
  const [paymentOffset, setPaymentOffset] = useState(0)
  const [paymentTotal, setPaymentTotal] = useState(0)
  const [paymentSum, setPaymentSum] = useState(0)

  const text = SIDE_TEXT[side]

  const load = useCallback(
    async (nextFilters: PaymentQuery, nextOffset: number) => {
      setLoading(true)
      try {
        const [summaryData, paymentData] = await Promise.all([
          fetchSettlementSummary(nextFilters.side),
          fetchPayments({
            ...nextFilters,
            limit: PAGE_SIZE,
            offset: nextOffset,
          }),
        ])
        setSummary(summaryData)
        setPayments(paymentData.rows)
        setPaymentTotal(paymentData.total)
        setPaymentSum(paymentData.total_amount)
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载失败')
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    // 切换应收/应付时保留其它筛选条件，只换方向，并回到第一页
    setPaymentFilters((prev) => (prev.side === side ? prev : { ...prev, side }))
    setPaymentOffset(0)
  }, [side])

  useEffect(() => {
    void load(paymentFilters, paymentOffset)
  }, [load, paymentFilters, paymentOffset])

  const handlePaymentSearch = () => {
    setPaymentOffset(0)
    setPaymentFilters({
      side,
      payment_no: paymentInput.payment_no.trim(),
      partner: paymentInput.partner.trim(),
      method: paymentInput.method.trim(),
      date_from: paymentInput.date_from,
      date_to: paymentInput.date_to,
    })
  }

  const handlePaymentReset = () => {
    setPaymentInput({ payment_no: '', partner: '', method: '', date_from: '', date_to: '' })
    setPaymentOffset(0)
    setPaymentFilters({ side })
  }

  const rows = summary?.rows ?? []
  const totals = summary?.totals

  // 有余额的往来单位排在前面，已结清的沉到最后
  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => b.balance - a.balance),
    [rows],
  )

  const openStatement = async (partner: string, nextPeriod = period) => {
    setStatementPartner(partner)
    setStatementLoading(true)
    setError('')
    try {
      setStatement(
        await fetchStatement({
          side,
          partner,
          date_from: nextPeriod.from,
          date_to: nextPeriod.to,
        }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载对账单失败')
    } finally {
      setStatementLoading(false)
    }
  }

  const handleStatementPeriod = async () => {
    if (!statementPartner) return
    if (period.from && period.to && period.from > period.to) {
      setError('起始日期不能晚于结束日期')
      return
    }
    await openStatement(statementPartner, period)
  }

  const handleStatementExport = async () => {
    if (!statementPartner) return
    setExporting(true)
    try {
      await downloadFile(
        statementExportUrl({
          side,
          partner: statementPartner,
          date_from: period.from,
          date_to: period.to,
        }),
        `对账单_${statementPartner}.xlsx`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  const openPayment = (partner = '') => {
    setPaymentForm({ ...emptyPaymentForm(), partner })
    setPaymentError('')
    setPaymentOpen(true)
  }

  const submitPayment = async () => {
    const partner = paymentForm.partner.trim()
    const amount = Number(paymentForm.amount)

    if (!partner) {
      setPaymentError(`${text.label}不能为空`)
      return
    }
    if (!(amount > 0)) {
      setPaymentError('金额必须大于 0')
      return
    }

    setSaving(true)
    setPaymentError('')
    try {
      const result = await createPayment({
        side,
        partner,
        amount,
        pay_date: paymentForm.pay_date,
        method: paymentForm.method.trim(),
        remark: paymentForm.remark.trim(),
      })
      setPaymentOpen(false)
      setNotice(`已记${text.money} ${result.payment_no}：${partner} ${formatAmount(amount)} 元`)
      // 刚记的这条要看得见：回到第一页并保持当前筛选
      setPaymentOffset(0)
      await load(paymentFilters, 0)
      // 对账单开着就顺手刷新
      if (statement && statement.partner === partner) {
        await openStatement(partner)
      }
    } catch (err) {
      setPaymentError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await deletePayment(deleteTarget.id)
      setNotice(`已删除${text.money}记录 ${deleteTarget.payment_no}`)
      setDeleteTarget(null)
      await load(paymentFilters, paymentOffset)
      if (statement && statement.partner === deleteTarget.partner) {
        await openStatement(deleteTarget.partner)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
      setDeleteTarget(null)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <section>
      <PageHead
        title="对账"
        subtitle="按往来单位核对账目：期初 + 本期发生 − 本期收付 = 期末，可导出或打印对账单"
        extra={
          <div className="segmented" role="tablist" aria-label="对账方向">
            <button
              type="button"
              role="tab"
              aria-selected={side === 'customer'}
              className={side === 'customer' ? 'segmented-item is-on' : 'segmented-item'}
              onClick={() => setSide('customer')}
            >
              应收（客户）
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={side === 'supplier'}
              className={side === 'supplier' ? 'segmented-item is-on' : 'segmented-item'}
              onClick={() => setSide('supplier')}
            >
              应付（供应商）
            </button>
          </div>
        }
      />

      <ToastHost
        items={[
          notice
            ? {
                id: 'settlement-notice',
                kind: 'success' as const,
                message: notice,
                onClose: () => setNotice(''),
              }
            : null,
          error
            ? {
                id: 'settlement-error',
                kind: 'error' as const,
                message: error,
                onClose: () => setError(''),
              }
            : null,
        ]}
      />

      <div className="card">
        <h2 className="section-title">{text.side}明细（按{text.label}）</h2>

        <table className="table">
          <thead>
            <tr>
              <th>{text.label}</th>
              <th className="num">单据数</th>
              <th className="num">累计发生</th>
              <th className="num">累计{text.money}</th>
              <th className="num">当前{text.side}</th>
              <th>最近单据</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => (
              <tr key={row.partner}>
                <td>{row.partner}</td>
                <td className="num">{row.order_count}</td>
                <td className="num">{formatAmount(row.order_amount)}</td>
                <td className="num">{formatAmount(row.paid)}</td>
                <td className={row.balance > 0 ? 'num amount' : 'num'}>
                  {formatAmount(row.balance)}
                </td>
                <td>{row.last_order_date || '—'}</td>
                <td>
                  <div className="row-actions">
                    <button
                      className="btn btn-sm"
                      onClick={() => void openStatement(row.partner)}
                    >
                      对账单
                    </button>
                    <button className="btn btn-sm" onClick={() => openPayment(row.partner)}>
                      记{text.money}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {!loading && sortedRows.length === 0 && (
          <EmptyState text={`还没有和${text.label}的往来单据`} />
        )}
        {loading && <TableSkeleton rows={5} cols={5} />}

        <div className="totals">
          <span>合计发生：{formatAmount(totals?.order_amount ?? 0)}</span>
          <span>合计{text.money}：{formatAmount(totals?.paid ?? 0)}</span>
          <span>
            当前{text.side}合计：{formatAmount(totals?.balance ?? 0)}
          </span>
        </div>
      </div>

      <div className="card">
        <h2 className="section-title">{text.money}记录</h2>

        <div className="toolbar" style={{ marginTop: 0, marginBottom: 16 }}>
          <input
            className="input"
            placeholder="单号关键字"
            value={paymentInput.payment_no}
            onChange={(event) =>
              setPaymentInput((prev) => ({ ...prev, payment_no: event.target.value }))
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter') handlePaymentSearch()
            }}
          />
          <input
            className="input"
            placeholder={`${text.label}关键字`}
            value={paymentInput.partner}
            onChange={(event) =>
              setPaymentInput((prev) => ({ ...prev, partner: event.target.value }))
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter') handlePaymentSearch()
            }}
          />
          <input
            className="input"
            placeholder="方式"
            value={paymentInput.method}
            onChange={(event) =>
              setPaymentInput((prev) => ({ ...prev, method: event.target.value }))
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter') handlePaymentSearch()
            }}
          />
          <input
            className="input"
            type="date"
            value={paymentInput.date_from}
            onChange={(event) =>
              setPaymentInput((prev) => ({ ...prev, date_from: event.target.value }))
            }
          />
          <span className="muted">至</span>
          <input
            className="input"
            type="date"
            value={paymentInput.date_to}
            onChange={(event) =>
              setPaymentInput((prev) => ({ ...prev, date_to: event.target.value }))
            }
          />
          <button className="btn" onClick={handlePaymentSearch}>
            查询
          </button>
          <button className="btn" onClick={handlePaymentReset}>
            重置
          </button>
          <span className="spacer" />
          <button className="btn btn-primary" onClick={() => openPayment()}>
            新增{text.money}
          </button>
        </div>

        <table className="table">
          <thead>
            <tr>
              <th>单号</th>
              <th>日期</th>
              <th>{text.label}</th>
              <th className="num">金额</th>
              <th>方式</th>
              <th>备注</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((row) => (
              <tr key={row.id}>
                <td>{row.payment_no}</td>
                <td>{row.pay_date}</td>
                <td>{row.partner}</td>
                <td className="num amount">{formatAmount(row.amount)}</td>
                <td>{row.method || '—'}</td>
                <td>{row.remark || '—'}</td>
                <td>
                  <div className="row-actions">
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => setDeleteTarget(row)}
                    >
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {!loading && payments.length === 0 && <EmptyState text={`暂无${text.money}记录`} />}

        <Pager
          total={paymentTotal}
          limit={PAGE_SIZE}
          offset={paymentOffset}
          onChange={setPaymentOffset}
          unit={`条，合计 ${formatAmount(paymentSum)} 元`}
        />
      </div>

      {(statement || statementLoading) && (
        <div className="overlay" onClick={() => setStatement(null)}>
          <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h2 className="modal-title">
                对账单：{statementPartner}（{text.side}）
              </h2>
              <div className="modal-actions">
                <button
                  className="btn btn-sm"
                  onClick={() => void handleStatementExport()}
                  disabled={exporting}
                >
                  {exporting ? '导出中…' : '导出 Excel'}
                </button>
                <button className="btn btn-sm" onClick={() => window.print()}>
                  打印
                </button>
                <button className="btn btn-sm btn-quiet" onClick={() => setStatement(null)}>
                  关闭
                </button>
              </div>
            </div>

            <div className="toolbar" style={{ marginBottom: 18 }}>
              <label className="field">
                <span>起始日期</span>
                <input
                  className="input"
                  type="date"
                  value={period.from}
                  onChange={(event) =>
                    setPeriod((prev) => ({ ...prev, from: event.target.value }))
                  }
                />
              </label>
              <label className="field">
                <span>结束日期</span>
                <input
                  className="input"
                  type="date"
                  value={period.to}
                  onChange={(event) =>
                    setPeriod((prev) => ({ ...prev, to: event.target.value }))
                  }
                />
              </label>
              <button className="btn" onClick={() => void handleStatementPeriod()}>
                查询
              </button>
              <button
                className="btn"
                onClick={() => {
                  const all = { from: '', to: '' }
                  setPeriod(all)
                  void openStatement(statementPartner, all)
                }}
              >
                全部
              </button>
            </div>

            {statementLoading && <Loading />}

            {statement && !statementLoading && (
              <div className="print-area">
                <h3 className="print-title">
                  立川云木材管理系统 · {text.label}对账单
                </h3>
                <p className="print-sub">
                  往来单位：{statement.partner}　　期间：{statement.date_from || '不限'} ~{' '}
                  {statement.date_to || '不限'}
                </p>

                <table className="table">
                  <thead>
                    <tr>
                      <th>日期</th>
                      <th>类型</th>
                      <th>单号</th>
                      <th>摘要</th>
                      <th className="num">立方</th>
                      <th className="num">发生金额</th>
                      <th className="num">余额</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>{statement.date_from || '—'}</td>
                      <td>期初</td>
                      <td>—</td>
                      <td>期初余额</td>
                      <td className="num">—</td>
                      <td className="num">—</td>
                      <td className="num">{formatAmount(statement.opening)}</td>
                    </tr>
                    {statement.rows.map((row) => (
                      <tr key={`${row.kind}-${row.no}-${row.date}`}>
                        <td>{row.date}</td>
                        <td>
                          <span className={row.kind === 'order' ? 'tag tag-in' : 'tag tag-out'}>
                            {row.kind === 'order' ? '单据' : text.money}
                          </span>
                        </td>
                        <td>{row.no}</td>
                        <td>{row.summary}</td>
                        <td className="num">
                          {row.kind === 'order' ? formatCubic(row.cubic) : '—'}
                        </td>
                        <td className="num">{formatAmount(row.amount)}</td>
                        <td className="num amount">{formatAmount(row.balance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {statement.rows.length === 0 && (
                  <EmptyState text="这个期间没有发生额" />
                )}

                <div className="totals">
                  <span>期初：{formatAmount(statement.opening)}</span>
                  <span>本期发生：{formatAmount(statement.period_occurred)}</span>
                  <span>
                    本期{text.money}：{formatAmount(statement.period_paid)}
                  </span>
                  <span>
                    期末{text.side}：{formatAmount(statement.closing)}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {paymentOpen && (
        <div className="overlay" onClick={() => setPaymentOpen(false)}>
          <div
            className="modal modal-narrow modal-sheet"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <h2 className="modal-title">新增{text.money}</h2>
              <button
                className="btn btn-sm btn-quiet"
                onClick={() => setPaymentOpen(false)}
              >
                关闭
              </button>
            </div>

            <label className="field field-required">
              <span>{text.label}</span>
              <input
                className="input"
                list="settlement-partners"
                value={paymentForm.partner}
                onChange={(event) =>
                  setPaymentForm((prev) => ({ ...prev, partner: event.target.value }))
                }
              />
            </label>
            <datalist id="settlement-partners">
              {rows.map((row) => (
                <option key={row.partner} value={row.partner} />
              ))}
            </datalist>

            <label className="field" style={{ marginTop: 14 }}>
              <span>金额（元）</span>
              <input
                className="input"
                inputMode="decimal"
                value={paymentForm.amount}
                onChange={(event) =>
                  setPaymentForm((prev) => ({ ...prev, amount: event.target.value }))
                }
              />
            </label>

            <label className="field" style={{ marginTop: 14 }}>
              <span>日期</span>
              <input
                className="input"
                type="date"
                value={paymentForm.pay_date}
                onChange={(event) =>
                  setPaymentForm((prev) => ({ ...prev, pay_date: event.target.value }))
                }
              />
            </label>

            <label className="field" style={{ marginTop: 14 }}>
              <span>方式</span>
              <input
                className="input"
                placeholder="银行转账 / 现金 / 承兑…"
                value={paymentForm.method}
                onChange={(event) =>
                  setPaymentForm((prev) => ({ ...prev, method: event.target.value }))
                }
              />
            </label>

            <label className="field" style={{ marginTop: 14 }}>
              <span>备注</span>
              <input
                className="input"
                value={paymentForm.remark}
                onChange={(event) =>
                  setPaymentForm((prev) => ({ ...prev, remark: event.target.value }))
                }
              />
            </label>

            {paymentError && <p className="login-error">{paymentError}</p>}

            <div className="confirm-actions">
              <button className="btn" onClick={() => setPaymentOpen(false)} disabled={saving}>
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void submitPayment()}
                disabled={saving}
              >
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="overlay" onClick={() => setDeleteTarget(null)}>
          <div
            className="modal modal-narrow modal-alert"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="modal-title">删除{text.money}记录</h2>
            <p className="confirm-text">
              确认删除 {deleteTarget.payment_no}（{deleteTarget.partner}{' '}
              {formatAmount(deleteTarget.amount)} 元）？删完该单位的{text.side}会相应增加。
            </p>
            <div className="confirm-actions">
              <button
                className="btn"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
              >
                取消
              </button>
              <button
                className="btn btn-danger-solid"
                onClick={() => void confirmDelete()}
                disabled={deleting}
              >
                {deleting ? '删除中…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
