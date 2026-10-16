/**
 * 表单里的「下一格」。
 *
 * 手机键盘上按下「下一项 / 回车」时调用：跳到**当前表里下一个看得见的**输入框
 * （被「更多」收起来的字段会被 offsetParent 过滤掉）；已经是最后一格就收起键盘。
 * 这样录一行的时候手指不用离开键盘去找下一格。
 */
export function focusNextInput(current: HTMLElement) {
  const scope = current.closest('table') ?? document
  const inputs = Array.from(
    scope.querySelectorAll<HTMLInputElement>('input.sheet-input, input.input'),
  ).filter(
    (el) =>
      el.offsetParent !== null &&
      !el.disabled &&
      !el.readOnly &&
      el.getAttribute('inputmode') !== null,
  )
  const index = inputs.indexOf(current as HTMLInputElement)
  const next = index >= 0 ? inputs[index + 1] : undefined
  if (next) {
    next.focus()
    next.select()
    return
  }
  current.blur()
}

/** 给输入框用的 onKeyDown：回车 = 下一格 */
export const enterToNext = (event: React.KeyboardEvent<HTMLInputElement>) => {
  if (event.key !== 'Enter') return
  event.preventDefault()
  focusNextInput(event.currentTarget)
}
