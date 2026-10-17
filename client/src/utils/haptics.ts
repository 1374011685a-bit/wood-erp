/**
 * 触觉反馈分三档（只有 Android / 支持 vibrate 的浏览器有反应）。
 *
 * iOS Safari 没有 `navigator.vibrate`，调用会被忽略、不会报错 ——
 * 所以可以放心在共用组件里直接调，不用先判断平台。
 *
 * 分档的口径（照着 iOS 的 Haptic 强度来）：
 *   tapLight  10ms —— 导航、切换、勾选这类"轻"动作
 *   tapMedium 20ms —— 提交、保存成功这类"有结果"的动作
 *   tapHeavy  35ms —— 删除、移入回收站这类"不可逆"的动作
 */
const buzz = (ms: number) => {
  try {
    navigator.vibrate?.(ms)
  } catch {
    /* 不支持就算了，别让触觉反馈把主流程带崩 */
  }
}

/** 轻：导航、切换、勾选 */
export const tapLight = () => buzz(10)
/** 中：提交、保存 */
export const tapMedium = () => buzz(20)
/** 重：删除、不可逆操作 */
export const tapHeavy = () => buzz(35)

/** 老名字，等价于轻震动（历史调用点不用改） */
export const tapFeedback = tapLight
