import { resolve } from 'path'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import type { Plugin } from 'vite'

const standaloneOnly = process.env.CODETASK_BUILD_TARGET === 'standalone'
const sandboxInputs = {
  'sandbox/role-worker': resolve('src/sandbox/role-worker.ts'),
  'sandbox/role-worker-cursor-job': resolve('src/sandbox/role-worker-cursor-job.ts'),
  'sandbox/supervisor-entry': resolve('src/sandbox/supervisor-entry.ts')
}

function standaloneRendererAssetBasePlugin(): Plugin {
  return {
    name: 'codetask:standalone-renderer-asset-base',
    enforce: 'post' as const,
    transformIndexHtml: {
      order: 'post' as const,
      handler(html: string): string {
        return html.replace(/(["'])\.\/assets\//g, '$1/assets/')
      }
    }
  }
}

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          ...(!standaloneOnly ? { index: resolve('src/main/index.ts') } : {}),
          standalone: resolve('src/standalone/index.ts'),
          ...sandboxInputs
        }
      }
    }
  },
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [
      vue(),
      tailwindcss(),
      ...(standaloneOnly ? [standaloneRendererAssetBasePlugin()] : [])
    ]
  }
})
