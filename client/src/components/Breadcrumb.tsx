export type Crumb = {
  /** 这一段显示什么字 */
  label: string
  /**
   * 点了干什么（一般是"回退到这一层"）。
   * **不传 = 这段不可点**；最后一段（当前层）也永远不可点。
   */
  onClick?: () => void
}

/**
 * 面包屑：一眼看出"我现在在哪一层"，前几段点一下就能退回去。
 *
 * 组件本身不管"回退"到底做什么 —— 那由调用方决定。
 * 采购入库明细里就是改地址栏的 `?contract=&shipment=`（刷新/后退都不丢位置）。
 *
 * 用法：
 *   <Breadcrumb items={[
 *     { label: '全部合同', onClick: () => clearAll() },
 *     { label: 'A11', onClick: () => clearShipment() },
 *     { label: '提单 C1' },                      // 当前层，不可点
 *   ]} />
 */
export default function Breadcrumb({ items }: { items: Crumb[] }) {
  if (items.length === 0) return null

  return (
    <nav className="breadcrumb" aria-label="当前位置">
      {items.map((item, index) => {
        const isCurrent = index === items.length - 1
        return (
          <span className="breadcrumb-item" key={`${item.label}-${index}`}>
            {index > 0 && (
              <span className="breadcrumb-sep" aria-hidden="true">
                ›
              </span>
            )}
            {isCurrent || !item.onClick ? (
              <span className="breadcrumb-current" aria-current="page">
                {item.label}
              </span>
            ) : (
              <button type="button" className="breadcrumb-link" onClick={item.onClick}>
                {item.label}
              </button>
            )}
          </span>
        )
      })}
    </nav>
  )
}
