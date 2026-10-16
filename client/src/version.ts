/**
 * App 版本号 —— 全站只有这一处读，值来自仓库根目录 package.json 的 version
 * （vite.config.ts 构建时用 define 注入 `__APP_VERSION__`）。
 * 升版本只改 package.json 一处，登录页和「我的」页会跟着变。
 */
export const APP_VERSION = `v${__APP_VERSION__}`

/** 带产品名的一整行，页脚那种灰字用 */
export const APP_VERSION_TEXT = `立川云木材管理系统 · ${APP_VERSION}`

/**
 * 构建时间（`2026-10-16 12:30`）。
 *
 * 和版本号一起显示：手机上缓存了旧包时，版本号可能还是 v0.1.0 看不出来，
 * 但构建时间不一样 —— 一眼就知道手上这份是不是最新的。
 */
export const APP_BUILD_TEXT = `构建 ${__BUILD_TIME__}`
