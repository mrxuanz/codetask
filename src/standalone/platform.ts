import { existsSync } from 'fs'
import { dirname, join, resolve } from 'path'
import type { AppServerPlatform } from '../main/server'
import { loadNodeAuthSecret } from './app-secret'
import { resolveNodeDataDirSelection } from './data-dir'

function firstExistingDirectory(candidates: string[]): string | undefined {
  return candidates.find((candidate) => existsSync(candidate))
}

export function resolveStandaloneStaticDir(): string | undefined {
  const configured = process.env.CODETASK_STATIC_DIR?.trim()
  if (configured) return resolve(configured)

  const entryDir = process.argv[1] ? dirname(resolve(process.argv[1])) : process.cwd()
  return firstExistingDirectory([
    join(entryDir, '..', 'renderer'),
    join(process.cwd(), 'out', 'renderer')
  ])
}

/** Pure Node adapter for the shared HTTP/runtime composition. */
export function createNodeServerPlatform(): AppServerPlatform {
  const rendererDevUrl = process.env.CODETASK_RENDERER_DEV_URL?.trim()
  return {
    isDev: Boolean(rendererDevUrl),
    rendererDevUrl,
    staticDir: rendererDevUrl ? undefined : resolveStandaloneStaticDir(),
    appRoot: resolve(process.env.CODETASK_APP_ROOT?.trim() || process.cwd()),
    resolveDataDirSelection: (input) => resolveNodeDataDirSelection(input),
    loadAuthSecret: loadNodeAuthSecret
  }
}
