/**
 * App 版本号 —— 全站只有这一处读，值来自仓库根目录 package.json 的 version
 * （vite.config.ts 构建时用 define 注入 `__APP_VERSION__`）。
 * 升版本只改 package.json 一处，登录页和「我的」页会跟着变。
 */
export const APP_VERSION = `v${__APP_VERSION__}`

/** 带产品名的一整行，页脚那种灰字用 */
export const APP_VERSION_TEXT = `立川云木材管理系统 · ${APP_VERSION}`
