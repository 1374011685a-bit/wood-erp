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
  markListTables(root)
  markSheetTables(root)
}

/**
 * 手机上窄字段名：桌面表头写的是「合同号 / 提单号」，塞进 7em 的标签位会被截成
 * 「合同号 / 提单…」。手机端换一个短的，**只影响 data-label（手机卡片里的字段名）**，
 * 桌面表头一个字不动。
 */
const SHORT_LABELS: Record<string, string> = {
  '合同号 / 提单号': '合同 / 提单',
}

/** 列表页的普通表格：整行变成一张「字段名 + 值」的卡片 */
function markListTables(root: ParentNode) {
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
        const shown = SHORT_LABELS[label] ?? label
        if (shown && cell.dataset.label !== shown) cell.dataset.label = shown
      })

      /**
       * 勾选列（整格只有一个复选框、没有文字）单独标出来：
       * 它在卡片模式里要浮到右上角，不能当成卡片标题，
       * 否则卡片顶上会出现一条只有方框的空白行。
       */
      const checkCell = cells.find(
        (cell) =>
          cell.querySelector('input[type="checkbox"]') !== null &&
          (cell.textContent ?? '').trim() === '',
      )
      if (checkCell) checkCell.classList.add('cell-check')

      /**
       * 操作列优先认 .row-actions（那才是「查看/编辑/删除」那一格）。
       * 只看 button 的话，像「合同号」这种格子里带链接按钮的会被误认成操作列，
       * 结果操作按钮被塞到卡片中间。
       */
      const actionCell =
        cells.find((cell) => cell.querySelector('.row-actions')) ??
        cells.find((cell) => cell.querySelector('button'))
      if (actionCell) actionCell.classList.add('cell-actions')

      // 卡片标题：第一个有文字的格子（跳过勾选列和只有按钮的操作列）
      const primary =
        cells.find(
          (cell) =>
            !cell.classList.contains('cell-check') &&
            !cell.classList.contains('cell-actions') &&
            (cell.textContent ?? '').trim().length > 0,
        ) ?? cells[0]
      primary.classList.add('cell-primary')
    }
  }
}

/**
 * 录入页的明细表（.sheet-table）：手机上也是一行一张卡片。
 *
 * 和列表页的区别：这里的格子多半是输入框，所以只搬字段名（data-label），
 * 不标「标题格 / 操作格」——哪一列当标题、哪一列放删除按钮，CSS 里按
 * col-code / col-name / col-op 这些已有的列类名来决定。
 */
function markSheetTables(root: ParentNode) {
  for (const table of root.querySelectorAll<HTMLTableElement>('table.sheet-table')) {
    const headers = [...table.querySelectorAll<HTMLTableCellElement>('thead th')]
    if (headers.length === 0) continue

    table.classList.add('sheet-cards')

    for (const row of table.querySelectorAll<HTMLTableRowElement>('tbody tr')) {
      const cells = [...row.children] as HTMLTableCellElement[]
      // 行列数对不上（比如 colSpan 的提示行 / 空状态行）就跳过
      if (cells.length !== headers.length) continue

      cells.forEach((cell, index) => {
        /*
         * 作者显式写死的 data-label 优先：明细行在手机上要缩短字段名
         * （「厚度 (mm)」在三分之一格里会把输入框挤没），那种格子带着自己的短名字，
         * 别让表头的长名字覆盖掉。
         */
        if (cell.dataset.label) return
        const label = headers[index]?.textContent?.trim() ?? ''
        if (label) cell.dataset.label = label
      })
    }
  }
}
