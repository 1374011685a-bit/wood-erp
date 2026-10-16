/// <reference types="vite/client" />

/** 版本号：由 vite.config.ts 的 define 从根 package.json 注入（见 src/version.ts） */
declare const __APP_VERSION__: string

/** 构建时间：由 vite.config.ts 的 define 在构建时注入（`2026-10-16 12:30`） */
declare const __BUILD_TIME__: string
