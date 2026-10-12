import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 前端 5173，后端 3001；/api 由前端代理到后端
export default defineConfig({
  plugins: [react()],
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
})
