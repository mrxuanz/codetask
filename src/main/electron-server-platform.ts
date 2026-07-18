import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { join } from 'path'
import { loadMainProcessAuthSecret } from './app-secret'
import { resolveDataDirSelection } from './data-dir'
import type { AppServerPlatform } from './server'

/** Electron-only adapter for the shared HTTP/runtime composition. */
export function createElectronServerPlatform(): AppServerPlatform {
  return {
    isDev: is.dev,
    rendererDevUrl: process.env.ELECTRON_RENDERER_URL,
    staticDir: is.dev ? undefined : join(__dirname, '../renderer'),
    appRoot: app.getAppPath(),
    resolveDataDirSelection,
    loadAuthSecret: loadMainProcessAuthSecret
  }
}
