/**
 * 列表分页参数
 *
 * 约定：limit 每页条数（默认 20，最多 200），offset 从第几条开始。
 * 传了非法值就退回默认，避免前端传个空串把整表拉出来。
 */
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 200

export function pageParams(query = {}) {
  const rawLimit = Number(query.limit)
  const rawOffset = Number(query.offset)

  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
      : DEFAULT_LIMIT
  const offset =
    Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0

  return { limit, offset }
}

export { DEFAULT_LIMIT, MAX_LIMIT }
