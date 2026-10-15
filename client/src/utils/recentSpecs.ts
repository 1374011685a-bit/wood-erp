/**
 * 「常用规格」：把最近录过的规格记在本机（localStorage），下次录单点一下就填好。
 *
 * 为什么不走接口：这是**本机习惯**，不同仓管、不同仓库用的规格不一样；
 * 存本地既不用改服务端，也不会把 A 仓库的习惯带给 B 仓库。
 * 最多留 6 条，最近用的排前面。
 */
export type RecentSpec = {
  species: string
  grade: string
  thickness: string
  width: string
  length: string
}

const KEY = 'wood-erp-recent-specs'
const MAX = 6

export function readRecentSpecs(): RecentSpec[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const list = JSON.parse(raw)
    return Array.isArray(list) ? (list as RecentSpec[]).slice(0, MAX) : []
  } catch {
    return []
  }
}

/** 保存成功后调用：把这张单里的规格记下来（去重、最近的排前面） */
export function rememberSpecs(
  items: Array<Record<string, unknown>>,
): RecentSpec[] {
  const keyOf = (one: RecentSpec) =>
    [one.species, one.grade, one.thickness, one.width, one.length].join('|')

  const fresh: RecentSpec[] = []
  for (const item of items) {
    const one: RecentSpec = {
      species: String(item.species ?? '').trim(),
      grade: String(item.grade ?? '').trim(),
      thickness: String(item.thickness ?? '').trim(),
      width: String(item.width ?? '').trim(),
      length: String(item.length ?? '').trim(),
    }
    // 品名 / 规格不全的不记（点了也填不出东西）
    if (!one.species || !one.thickness || !one.width || !one.length) continue
    if (!fresh.some((x) => keyOf(x) === keyOf(one))) fresh.push(one)
  }

  const merged = [...fresh, ...readRecentSpecs().filter((old) => !fresh.some((x) => keyOf(x) === keyOf(old)))]
  const next = merged.slice(0, MAX)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* 存不进去就算了，不影响保存 */
  }
  return next
}
