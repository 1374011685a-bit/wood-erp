import ExcelJS from 'exceljs'

/* ---------- 样式常量 ---------- */

const THIN = { style: 'thin', color: { argb: 'FFD9D9D9' } }
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN }
const HEADER_FILL = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFF0F0F0' },
}
const TOTAL_FILL = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFFFBE6' },
}

/** 估算文本宽度：中文（含全角）算 2 个字符 */
function textWidth(value) {
  if (value === null || value === undefined) return 0
  let width = 0
  for (const char of String(value)) {
    width += /[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/.test(char) ? 2 : 1
  }
  return width
}

function numberFormat(column) {
  const digits = column.decimals ?? 0
  return digits > 0 ? `0.${'0'.repeat(digits)}` : '0'
}

function applyNumberStyle(cell, column) {
  cell.numFmt = numberFormat(column)
  cell.alignment = { horizontal: 'right', vertical: 'middle' }
}

/**
 * 生成一个带标题、表头、数据与合计行的 xlsx
 *
 * @param {object} options
 * @param {string} options.title     第一行合并标题
 * @param {string} options.subtitle  第二行合并副标题（导出时间、条数）
 * @param {Array<{key:string,header:string,type?:'text'|'number'|'integer',decimals?:number}>} options.columns
 * @param {Array<object>} options.rows
 * @param {object} [options.totals]  合计行的值（key 与 columns 对应）
 * @returns {Promise<Buffer>}
 */
export async function buildWorkbook({ title, subtitle, columns, rows, totals }) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = '立川云木材管理系统'
  workbook.created = new Date()

  const sheet = workbook.addWorksheet(title.slice(0, 30))
  const lastColumn = columns.length

  // 第一行：标题
  sheet.mergeCells(1, 1, 1, lastColumn)
  const titleCell = sheet.getCell(1, 1)
  titleCell.value = title
  titleCell.font = { bold: true, size: 14 }
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' }
  sheet.getRow(1).height = 26

  // 第二行：导出时间 + 条数
  sheet.mergeCells(2, 1, 2, lastColumn)
  const subtitleCell = sheet.getCell(2, 1)
  subtitleCell.value = subtitle
  subtitleCell.font = { size: 10, color: { argb: 'FF808080' } }
  subtitleCell.alignment = { horizontal: 'right', vertical: 'middle' }
  sheet.getRow(2).height = 18

  // 第三行：表头
  const headerRow = sheet.getRow(3)
  columns.forEach((column, index) => {
    const cell = headerRow.getCell(index + 1)
    cell.value = column.header
    cell.font = { bold: true, size: 11 }
    cell.alignment = { horizontal: 'center', vertical: 'middle' }
    cell.fill = HEADER_FILL
    cell.border = BORDER
  })
  headerRow.height = 20

  // 数据行：数值列写入 number 类型
  rows.forEach((row, rowIndex) => {
    const excelRow = sheet.getRow(4 + rowIndex)
    columns.forEach((column, index) => {
      const cell = excelRow.getCell(index + 1)
      const value = row[column.key]
      cell.value = value === undefined || value === '' ? null : value
      cell.alignment = { vertical: 'middle', horizontal: 'left' }
      if (column.type === 'number') {
        applyNumberStyle(cell, column)
      } else if (column.type === 'integer') {
        applyNumberStyle(cell, column)
      }
      cell.border = BORDER
    })
  })

  // 合计行
  if (totals) {
    const totalRow = sheet.getRow(4 + rows.length)
    columns.forEach((column, index) => {
      const cell = totalRow.getCell(index + 1)
      const value = totals[column.key]
      cell.value = value === undefined || value === '' ? null : value
      cell.font = { bold: true }
      cell.fill = TOTAL_FILL
      cell.border = BORDER
      if (column.type === 'number' || column.type === 'integer') {
        applyNumberStyle(cell, column)
      } else {
        cell.alignment = { vertical: 'middle', horizontal: 'left' }
      }
    })
  }

  // 列宽：按表头、数据、合计里最宽的内容估算
  // 注意：exceljs 把「宽度恰好等于默认值 9」的列当成未自定义而不写入 <cols>，
  // 所以下限取 10，避免小列宽被吃掉
  columns.forEach((column, index) => {
    let width = textWidth(column.header)
    for (const row of rows) {
      width = Math.max(width, textWidth(row[column.key]))
    }
    if (totals && totals[column.key] !== undefined) {
      width = Math.max(width, textWidth(totals[column.key]))
    }
    sheet.getColumn(index + 1).width = Math.min(Math.max(width + 3, 10), 40)
  })

  return Buffer.from(await workbook.xlsx.writeBuffer())
}
