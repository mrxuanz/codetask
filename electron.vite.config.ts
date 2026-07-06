import { resolve } from 'path'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

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
          index: resolve('src/main/index.ts'),
          'sandbox/role-worker': resolve('src/sandbox/role-worker.ts'),
          'sandbox/role-worker-cursor-job': resolve('src/sandbox/role-worker-cursor-job.ts'),
          'sandbox/supervisor-entry': resolve('src/sandbox/supervisor-entry.ts')
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
    plugins: [vue(), tailwindcss()]
  }
})
