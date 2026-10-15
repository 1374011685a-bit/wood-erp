/**
 * 轻震动反馈（只有 Android / 支持 vibrate 的浏览器有反应）。
 *
 * iOS Safari 没有 `navigator.vibrate`，调用会被忽略、不会报错 ——
 * 所以可以放心在共用组件里直接调，不用先判断平台。
 * 只在手机端最常点的位置用：底部 Tab、首页宫格、表单的保存按钮。
 */
export function tapFeedback() {
  navigator.vibrate?.(10)
}
