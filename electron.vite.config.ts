import { resolve } from 'path'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

const sandboxInputs = {
  'sandbox/role-worker': resolve('src/sandbox/role-worker.ts'),
  'sandbox/role-worker-cursor-job': resolve('src/sandbox/role-worker-cursor-job.ts'),
  'sandbox/supervisor-entry': resolve('src/sandbox/supervisor-entry.ts'),
  'sandbox/provider-runtime-diagnostics': resolve('src/sandbox/provider-runtime-diagnostics.ts')
}

/** Workspace packages export raw `.ts`; Node strip-only cannot run them as externals. */
const workspacePackages = [
  '@codetask/server-core',
  '@codetask/contracts',
  '@codetask/database',
  '@codetask/agent-runtime',
  '@codetask/provider-runtime-node',
  '@codetask/service-bootstrap'
]

/** Desktop Electron build (main index + standalone sidecar + sandbox workers). */
export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@server': resolve('src/server')
      }
    },
    build: {
      // Bundle monorepo sources into main/standalone so `node out/main/standalone.js` is self-contained.
      externalizeDeps: {
        exclude: workspacePackages
      },
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          standalone: resolve('src/standalone/index.ts'),
          ...sandboxInputs
        }
      }
    }
  },
  preload: {},
  renderer: {
    root: resolve('apps/web'),
    server: {
      // Match desktop-service --renderer-dev-url http://127.0.0.1:5173 (avoid ::1-only bind).
      host: '127.0.0.1',
      port: 5173
    },
    build: {
      rollupOptions: {
        input: resolve('apps/web/index.html')
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('apps/web/src'),
        '@shared': resolve('src/shared'),
        '@codetask/contracts': resolve('packages/contracts/src/index.ts')
      }
    },
    plugins: [vue(), tailwindcss()]
  }
})
