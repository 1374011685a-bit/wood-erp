import { useCallback } from 'react'
import {
  useLocation,
  useNavigate,
  type NavigateFunction,
  type NavigateOptions,
  type To,
} from 'react-router-dom'

const TAB_PATHS = new Set(['/', '/documents', '/stock', '/me'])
let navSequence = 0

const targetPath = (to: To | number) => {
  if (typeof to === 'number') return ''
  if (typeof to === 'string') return to.split('?')[0]
  return to.pathname ?? ''
}

/** Mobile 专用 navigate：自动带方向并启用 React Router 的 View Transition。 */
export function useMobileNavigate(): NavigateFunction {
  const navigate = useNavigate()
  const location = useLocation()

  return useCallback<NavigateFunction>(
    ((to: To | number, options?: NavigateOptions) => {
      const path = targetPath(to)
      const direction =
        typeof to === 'number' && to < 0
          ? 'back'
          : path && TAB_PATHS.has(path)
            ? 'tab'
            : 'forward'

      const sequence = String((navSequence += 1))
      document.documentElement.dataset.mNav = direction
      document.documentElement.dataset.mNavSeq = sequence
      const result = (navigate as unknown as (
        target: To | number,
        opts?: NavigateOptions,
      ) => void | Promise<void>)(to, {
        ...options,
        viewTransition: true,
      })
      window.setTimeout(() => {
        if (document.documentElement.dataset.mNavSeq === sequence) {
          delete document.documentElement.dataset.mNav
          delete document.documentElement.dataset.mNavSeq
        }
      }, 380)
      return result
    }) as NavigateFunction,
    [location.pathname, navigate],
  )
}
