import { resolve } from 'path'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import type { Plugin } from 'vite'
import {
  bundledWorkspacePackages,
  mainAliases,
  rendererAliases,
  rendererInput,
  rendererRoot,
  sandboxInputs
} from './build/electron-vite.shared'

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

/**
 * Standalone / headless Node Service bundle build.
 * Use explicit config instead of CODETASK_BUILD_TARGET env (Batch E).
 */
export default defineConfig({
  main: {
    resolve: {
      alias: mainAliases
    },
    build: {
      externalizeDeps: {
        exclude: bundledWorkspacePackages
      },
      rollupOptions: {
        input: {
          standalone: resolve('apps/service/src/standalone.ts'),
          ...sandboxInputs
        }
      }
    }
  },
  renderer: {
    root: rendererRoot,
    build: {
      rollupOptions: {
        input: rendererInput
      }
    },
    resolve: {
      alias: rendererAliases
    },
    plugins: [vue(), tailwindcss(), standaloneRendererAssetBasePlugin()]
  }
})
