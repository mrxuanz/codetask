import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

const root = resolve(import.meta.dirname, '../..')
const DEFAULT_SERVICE_URL = 'http://127.0.0.1:8080'
const RUN_MANIFEST = resolve(root, '.codetask-run-manifest.json')

function resolveServiceProxyTarget(): string {
  if (!existsSync(RUN_MANIFEST)) return DEFAULT_SERVICE_URL
  try {
    const raw = JSON.parse(readFileSync(RUN_MANIFEST, 'utf8')) as { serviceUrl?: unknown }
    if (typeof raw.serviceUrl === 'string' && raw.serviceUrl.trim()) {
      return raw.serviceUrl.trim()
    }
  } catch {
    // Fall through to default.
  }
  return DEFAULT_SERVICE_URL
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@renderer': resolve(import.meta.dirname, 'src'),
      '@shared': resolve(root, 'src/shared'),
      '@codetask/contracts': resolve(root, 'packages/contracts/src/index.ts')
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: resolveServiceProxyTarget(),
        changeOrigin: true
      }
    }
  }
})
