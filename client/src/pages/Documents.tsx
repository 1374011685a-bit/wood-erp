import { useNavigate } from 'react-router-dom'
import { PageHead } from '../components/Ui'
import { useRole } from '../hooks/useRole'
import { canVisit } from '../permissions'

/**
 * 单据入口页 —— 手机上从底部「单据」Tab 进来。
 *
 * 这一版先做成列表（下一步再做宫格）：常用的 5 个单据页在上面，
 * 下面是手机上没别的地方能进的几个页面（侧边栏在手机端已经收起）。
 * 每一项都过一遍 `canVisit`，没权限的角色看不到、也进不去。
 */
const ENTRIES: { to: string; label: string; hint: string }[] = [
  { to: '/inbound', label: '采购入库', hint: '按提单一包包进货，混装包长度可以写 1.8/2.1/2.4' },
  { to: '/outbound', label: '出库', hint: '从库存里挑码单发货' },
  { to: '/contracts', label: '采购合同', hint: '登记合同和合同明细' },
  { to: '/repack', label: '改包', hint: '拆包 / 并包 / 改规格，改前改后都留痕' },
  { to: '/bales', label: '码单', hint: '一包一行，查货、条码号、打印标签' },
]

/** 不在底部 4 个 Tab 里、但手机上得进得去的页面 */
const MORE: { to: string; label: string; hint: string }[] = [
  { to: '/count', label: '盘点', hint: '盘盈盘亏，生成调整单' },
  { to: '/records', label: '流水', hint: '出入库的全部明细' },
  { to: '/settlement', label: '对账', hint: '按往来单位对账' },
  { to: '/recycle', label: '回收站', hint: '删掉的单据可以恢复' },
]

export default function Documents() {
  const role = useRole()
  const navigate = useNavigate()
  const entries = ENTRIES.filter((one) => canVisit(role, one.to))
  const more = MORE.filter((one) => canVisit(role, one.to))

  const renderList = (list: typeof ENTRIES) => (
    <div className="card entry-list">
      {list.map((one) => (
        <button
          key={one.to}
          type="button"
          className="entry-item"
          onClick={() => navigate(one.to)}
        >
          <span className="entry-main">
            <span className="entry-label">{one.label}</span>
            <span className="entry-hint">{one.hint}</span>
          </span>
          <span className="entry-arrow" aria-hidden="true">
            ›
          </span>
        </button>
      ))}
    </div>
  )

  return (
    <section>
      <PageHead title="单据" subtitle="要录单、查单，从这里进" />
      {entries.length > 0 && renderList(entries)}
      {more.length > 0 && (
        <>
          <h2 className="section-title">其他</h2>
          {renderList(more)}
        </>
      )}
    </section>
  )
}
