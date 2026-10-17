import { useEffect } from 'react'

const INPUT_SELECTOR = 'input.m-input, input.m-line-input, textarea.m-input'

const visibleInputs = () =>
  Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(INPUT_SELECTOR)).filter(
    (input) =>
      input.offsetParent !== null &&
      !input.disabled &&
      !input.readOnly &&
      input.getAttribute('type') !== 'hidden',
  )

const refreshHints = () => {
  const inputs = visibleInputs()
  inputs.forEach((input, index) => {
    input.enterKeyHint = index === inputs.length - 1 ? 'done' : 'next'
  })
}

/** 表单内 Enter / 键盘“下一项”串联，最后一格自动收起键盘。 */
export function useMobileFormKeyboard(enabled = true) {
  useEffect(() => {
    if (!enabled) return
    refreshHints()

    const onFocus = () => refreshHints()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.isComposing) return
      const target = event.target
      if (
        !(target instanceof HTMLInputElement) &&
        !(target instanceof HTMLTextAreaElement)
      ) {
        return
      }
      if (target instanceof HTMLTextAreaElement && event.shiftKey) return
      const inputs = visibleInputs()
      const index = inputs.indexOf(target)
      if (index < 0) return
      event.preventDefault()
      const next = inputs[index + 1]
      if (next) {
        next.focus()
        if (next instanceof HTMLInputElement) next.select()
      } else {
        target.blur()
      }
    }

    const observer = new MutationObserver(refreshHints)
    observer.observe(document.body, { childList: true, subtree: true })
    document.addEventListener('focusin', onFocus)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      observer.disconnect()
      document.removeEventListener('focusin', onFocus)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [enabled])
}
