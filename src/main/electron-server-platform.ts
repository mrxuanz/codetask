import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { join } from 'path'
import { resolveDataDirSelection } from './data-dir'
import type { AppServerPlatform } from './server'

/** Electron-only adapter for the shared HTTP/runtime composition. */
export function createElectronServerPlatform(): AppServerPlatform {
  return {
    isDev: is.dev,
    rendererDevUrl: is.dev ? 'http://localhost:5173' : undefined,
    staticDir: is.dev ? undefined : join(__dirname, '../renderer'),
    appRoot: app.getAppPath(),
    shellChildEnvironment: {
      ELECTRON_RUN_AS_NODE: '1'
    },
    resolveDataDirSelection
  }
}
