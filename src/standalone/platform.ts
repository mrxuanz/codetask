import { existsSync } from 'fs'
import { dirname, join, resolve } from 'path'
import type { AppServerPlatform } from '../main/server'
import { loadNodeAuthSecret } from './app-secret'
import { resolveNodeDataDirSelection } from './data-dir'
import type { CliOptions } from '../main/cli'

function firstExistingDirectory(candidates: string[]): string | undefined {
  return candidates.find((candidate) => existsSync(candidate))
}

export function resolveStandaloneStaticDir(configuredPath?: string): string | undefined {
  const configured = configuredPath?.trim()
  if (configured) return resolve(configured)

  const entryDir = process.argv[1] ? dirname(resolve(process.argv[1])) : process.cwd()
  return firstExistingDirectory([
    join(entryDir, '..', 'renderer'),
    join(process.cwd(), 'out', 'renderer')
  ])
}

/** Pure Node adapter for the shared HTTP/runtime composition. */
export function createNodeServerPlatform(cli: CliOptions): AppServerPlatform {
  const rendererDevUrl = cli.rendererDevUrl?.trim()
  return {
    isDev: Boolean(rendererDevUrl),
    rendererDevUrl,
    staticDir: rendererDevUrl ? undefined : resolveStandaloneStaticDir(cli.staticDir),
    appRoot: resolve(cli.appRoot?.trim() || process.cwd()),
    resolveDataDirSelection: (input) =>
      resolveNodeDataDirSelection({
        ...input,
        ...(cli.bootstrapRoot ? { bootstrapRoot: cli.bootstrapRoot } : {})
      }),
    loadAuthSecret: (input) =>
      loadNodeAuthSecret(input, {
        ...(cli.authSecretFile ? { credentialPath: cli.authSecretFile } : {})
      })
  }
}
