import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { join } from 'path'
import { loadMainProcessAuthSecret } from './app-secret'
import { resolveDataDirSelection } from './data-dir'
import type { AppServerPlatform } from './server'
import type { CliOptions } from './cli'

/** Electron-only adapter for the shared HTTP/runtime composition. */
export function createElectronServerPlatform(
  cli: CliOptions,
  runtime: { readonly rendererDevUrl?: string | undefined } = {}
): AppServerPlatform {
  return {
    isDev: is.dev,
    rendererDevUrl: runtime.rendererDevUrl,
    staticDir: is.dev ? undefined : join(__dirname, '../renderer'),
    appRoot: app.getAppPath(),
    resolveDataDirSelection: (input) =>
      resolveDataDirSelection({
        ...input,
        ...(cli.bootstrapRoot ? { bootstrapRoot: cli.bootstrapRoot } : {})
      }),
    loadAuthSecret: (input) =>
      loadMainProcessAuthSecret({
        ...input,
        ...(cli.authSecretFile ? { credentialPath: cli.authSecretFile } : {})
      })
  }
}
