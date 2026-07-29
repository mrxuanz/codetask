import { existsSync, readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import type { AppServerPlatform } from '../main/server'
import { resolveNodeDataDirSelection } from './data-dir'

function firstExistingDirectory(candidates: string[]): string | undefined {
  return candidates.find((candidate) => existsSync(candidate))
}

function isCodeTaskPackage(path: string): boolean {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as {
      name?: unknown
      main?: unknown
    }
    return value.name === 'task' || value.main === './out/main/index.js'
  } catch {
    return false
  }
}

export function resolveStandaloneAppRoot(): string {
  if (!process.argv[1] || resolve(process.argv[1]) === resolve(process.execPath)) {
    return dirname(dirname(resolve(process.execPath)))
  }

  let current = dirname(resolve(process.argv[1]))
  for (;;) {
    const packageJson = join(current, 'package.json')
    if (existsSync(packageJson) && isCodeTaskPackage(packageJson)) return current
    const parent = dirname(current)
    if (parent === current) return process.cwd()
    current = parent
  }
}

export function resolveStandaloneStaticDir(
  appRoot = resolveStandaloneAppRoot()
): string | undefined {
  return firstExistingDirectory([join(appRoot, 'renderer'), join(appRoot, 'out', 'renderer')])
}

/** Pure Node adapter for the shared HTTP/runtime composition. */
export function createNodeServerPlatform(): AppServerPlatform {
  const appRoot = resolveStandaloneAppRoot()
  return {
    isDev: false,
    staticDir: resolveStandaloneStaticDir(appRoot),
    appRoot,
    resolveDataDirSelection: (input) => resolveNodeDataDirSelection(input)
  }
}
