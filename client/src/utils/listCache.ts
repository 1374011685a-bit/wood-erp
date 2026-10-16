/**
 * 列表的「上一次结果」内存缓存。
 *
 * 切走再切回来时先用缓存把列表画出来（不闪空白、不闪骨架），
 * 同时后台静默刷新一遍，刷新期间列表头上挂一个「刷新中」的小角标。
 * 只存内存：刷新页面就没了 —— 这是"手感"用的，不是离线数据。
 */
const store = new Map<string, unknown>()

export function readListCache<T>(key: string): T | undefined {
  return store.get(key) as T | undefined
}

export function writeListCache<T>(key: string, value: T): void {
  store.set(key, value)
}

/** 清掉某个前缀的缓存（删除/新增之后用，免得回显旧数据） */
export function clearListCache(prefix: string): void {
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) store.delete(key)
  }
}
