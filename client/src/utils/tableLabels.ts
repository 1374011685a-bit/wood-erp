/**
 * 手机端卡片式表格的辅助工具。
 *
 * 把表头文字搬到每个数据格的 data-label 上，并标出「标题格」和「操作格」，
 * 手机上就能把一整行渲染成一张卡片（CSS 里用 data-label 显示字段名）。
 *
 * 这些属性和类名只在 @media (max-width: 767px) 的样式里生效，
 * 桌面端拿了也不用，所以 PC 渲染完全不受影响。
 *
 * 明细录入表（.table-detail）自带 data-label，这里跳过。
 */
export function applyTableLabels(root: ParentNode = document) {
  const tables = root.querySelectorAll<HTMLTableElement>('table.table')

  for (const table of tables) {
    if (table.classList.contains('table-detail')) continue

    const headers = [...table.querySelectorAll<HTMLTableCellElement>('thead th')]
    if (headers.length === 0) continue

    table.classList.add('table-cards')

    for (const row of table.querySelectorAll<HTMLTableRowElement>('tbody tr')) {
      const cells = [...row.children] as HTMLTableCellElement[]
      // 行列数对不上（比如 colSpan 的提示行）就跳过
      if (cells.length !== headers.length) continue

      cells.forEach((cell, index) => {
        const label = headers[index]?.textContent?.trim() ?? ''
        if (label && cell.dataset.label !== label) cell.dataset.label = label
      })

      cells[0].classList.add('cell-primary')

      const actionCell = cells.find((cell) =>
        cell.querySelector('.row-actions, button'),
      )
      if (actionCell) actionCell.classList.add('cell-actions')
    }
  }
}
