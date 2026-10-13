/**
 * 数字与显示格式：全站共用。
 * 以前每个页面各写一份，改一次要改十几处，统一放这里。
 */

/** 字符串/数字 → 数字，转不出来就是 0 */
export const toNumber = (value: string | number | null | undefined) => {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

/** 四舍五入到指定位数，返回数字 */
export const roundTo = (value: number, digits: number) =>
  Number(toNumber(value).toFixed(digits))

/** 立方：去掉无意义的末尾零（13.68） */
export const formatCubic = (value: number) => String(roundTo(value, 4))

/** 金额：固定两位（28728.00） */
export const formatAmount = (value: number | null | undefined) =>
  toNumber(value).toFixed(2)

/** 本地日期 YYYY-MM-DD（默认今天） */
export function todayISO(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 老页面里的名字，等价于 todayISO */
export const todayLocal = todayISO
