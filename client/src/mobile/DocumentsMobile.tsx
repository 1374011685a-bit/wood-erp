/** 单据（手机版）：把常用单据入口按大厂 App 的分组排开 */
import { useNavigate } from 'react-router-dom'
import { MobileCard, MobileIcon, MobileList, MobileListItem } from './components'

const GROUPS: Array<{
  title: string
  items: Array<{ to: string; label: string; sub: string; icon: 'box' | 'doc' | 'chart' | 'trash' }>
}> = [
  {
    title: '采购',
    items: [
      { to: '/inbound/new', label: '采购入库', sub: '扫单 / 选合同录一张单', icon: 'box' },
      { to: '/inbound', label: '入库单列表', sub: '查看、改单、移入回收站', icon: 'doc' },
      { to: '/contracts', label: '采购合同', sub: '合同台账与到货进度', icon: 'doc' },
    ],
  },
  {
    title: '销售',
    items: [
      { to: '/outbound/new', label: '出库', sub: '选码单发货，库存自动扣减', icon: 'box' },
      { to: '/outbound', label: '出库单列表', sub: '撤销出库、查看明细', icon: 'doc' },
    ],
  },
  {
    title: '仓库',
    items: [
      { to: '/bales', label: '采购入库明细', sub: '一包一行，打印标签', icon: 'doc' },
      { to: '/repack', label: '改包', sub: '拆包 / 合并 / 改规格', icon: 'box' },
      { to: '/count', label: '盘点', sub: '盘盈盘亏生成调整单', icon: 'chart' },
      { to: '/records', label: '流水', sub: '每一笔出入库明细', icon: 'chart' },
      { to: '/recycle', label: '回收站', sub: '删掉的单据在这里恢复', icon: 'trash' },
    ],
  },
]

export default function DocumentsMobile() {
  const navigate = useNavigate()
  return (
    <div className="m-stack">
      {GROUPS.map((group) => (
        <MobileCard title={group.title} key={group.title}>
          <MobileList>
            {group.items.map((item) => (
              <MobileListItem
                key={item.to + item.label}
                title={item.label}
                sub={item.sub}
                icon={<MobileIcon name={item.icon} size={20} />}
                onClick={() => {
                  if (item.to === '/inbound/new') return navigate('/inbound/new')
                  if (item.to === '/outbound/new') {
                    return navigate('/outbound/new')
                  }
                  navigate(item.to)
                }}
              />
            ))}
          </MobileList>
        </MobileCard>
      ))}
    </div>
  )
}
