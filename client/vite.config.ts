import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import rootPkg from '../package.json'

/**
 * 版本号的唯一来源：仓库根目录的 package.json。
 * 构建时用 define 注入成 `__APP_VERSION__`（登录页 / 我的页都读它），
 * 以后升版本只改 package.json 一处。
 */
const appVersion: string = rootPkg.version

/**
 * 构建时间：手机上"是不是最新包"一眼就能看出来。
 * 本地时间格式化成 `2026-10-16 12:30`，跟版本号一起显示在登录页 / 我的页。
 */
const pad = (value: number) => String(value).padStart(2, '0')
const builtAt = new Date()
const buildTime = `${builtAt.getFullYear()}-${pad(builtAt.getMonth() + 1)}-${pad(
  builtAt.getDate(),
)} ${pad(builtAt.getHours())}:${pad(builtAt.getMinutes())}`

// 前端 5173，后端 3001；/api 由前端代理到后端
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon-192.png', 'icons/icon-512.png'],
      manifest: {
        name: '立川云木材管理系统',
        short_name: '立川云',
        description: '木材进销存：入库、出库、库存、盘点、流水与对账',
        theme_color: '#1d1d1f',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        lang: 'zh-CN',
        icons: [
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // 静态资源预缓存
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // 接口一律走网络，绝不缓存，避免看到过期数据
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /^\/api\//,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    // 目标放到现代浏览器：少打一堆兼容转译代码
    target: 'es2022',
    cssCodeSplit: true,
    reportCompressedSize: false,
    rollupOptions: {
      output: {
        /**
         * 第三方库单独打一个包：
         * 1) 业务代码改动不会让 React / 路由这些包重新下载；
         * 2) 每个页面自己一个 chunk，点到才加载。
         */
        manualChunks(id: string) {
          if (id.includes('node_modules')) {
            // 扫码库和二维码生成库都挺大，各自单独一个包，点到才下载
            if (id.includes('html5-qrcode')) return 'qr-scanner'
            if (id.includes('qrcode')) return 'qr-generator'
            if (id.includes('react-router')) return 'vendor-router'
            if (id.includes('react')) return 'vendor-react'
            return 'vendor'
          }
          return undefined
        },
      },
    },
  },
})
