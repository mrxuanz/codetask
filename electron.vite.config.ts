import { resolve } from 'path'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import {
  bundledWorkspacePackages,
  mainAliases,
  rendererAliases,
  rendererInput,
  rendererRoot,
  sandboxInputs
} from './build/electron-vite.shared'

/** Desktop Electron build (main index + standalone sidecar + sandbox workers). */
export default defineConfig({
  main: {
    resolve: {
      alias: mainAliases
    },
    build: {
      // Bundle monorepo sources into main/standalone so `node out/main/standalone.js` is self-contained.
      externalizeDeps: {
        exclude: bundledWorkspacePackages
      },
      rollupOptions: {
        input: {
          index: resolve('apps/desktop/src/index.ts'),
          standalone: resolve('apps/service/src/standalone.ts'),
          ...sandboxInputs
        }
      }
    }
  },
  renderer: {
    root: rendererRoot,
    server: {
      // Match desktop-service --renderer-dev-url http://127.0.0.1:5173 (avoid ::1-only bind).
      host: '127.0.0.1',
      port: 5173
    },
    build: {
      rollupOptions: {
        input: rendererInput
      }
    },
    resolve: {
      alias: rendererAliases
    },
    plugins: [vue(), tailwindcss()]
  }
})
