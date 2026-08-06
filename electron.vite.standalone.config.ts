import { resolve } from 'path'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import type { Plugin } from 'vite'

const sandboxInputs = {
  'sandbox/role-worker': resolve('src/sandbox/role-worker.ts'),
  'sandbox/role-worker-cursor-job': resolve('src/sandbox/role-worker-cursor-job.ts'),
  'sandbox/supervisor-entry': resolve('src/sandbox/supervisor-entry.ts'),
  'sandbox/provider-runtime-diagnostics': resolve('src/sandbox/provider-runtime-diagnostics.ts')
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

/** Workspace packages export raw `.ts`; Node strip-only cannot run them as externals. */
const workspacePackages = [
  '@codetask/server-core',
  '@codetask/contracts',
  '@codetask/database',
  '@codetask/agent-runtime',
  '@codetask/provider-runtime-node',
  '@codetask/service-bootstrap'
]

/**
 * Standalone / headless Node Service bundle build.
 * Use explicit config instead of CODETASK_BUILD_TARGET env (Batch E).
 */
export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@server': resolve('src/server')
      }
    },
    build: {
      externalizeDeps: {
        exclude: workspacePackages
      },
      rollupOptions: {
        input: {
          standalone: resolve('src/standalone/index.ts'),
          ...sandboxInputs
        }
      }
    }
  },
  preload: {},
  renderer: {
    root: resolve('apps/web'),
    build: {
      rollupOptions: {
        input: resolve('apps/web/index.html')
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('apps/web/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [vue(), tailwindcss(), standaloneRendererAssetBasePlugin()]
  }
})
