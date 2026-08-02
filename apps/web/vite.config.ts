import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

const root = resolve(import.meta.dirname, '../../..')

export default defineConfig({
  root: resolve(root, 'src/renderer'),
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@renderer': resolve(root, 'src/renderer/src'),
      '@shared': resolve(root, 'src/shared'),
      '@codetask/contracts': resolve(root, 'packages/contracts/src/index.ts')
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.CODETASK_SERVICE_URL || 'http://127.0.0.1:8080',
        changeOrigin: true
      }
    }
  }
})
