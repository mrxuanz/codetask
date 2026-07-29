import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import type { AppMode } from '../main/cli'
import { resolveStorageLocation, type DataDirResolution } from '../main/storage-locator'
import {
  readInitializationConfig,
  resolveInitializationConfigPath
} from '../main/initialization-config'

export interface NodeDataDirRuntime {
  platform?: NodeJS.Platform
  homeDir?: string
  isPackaged?: boolean
  executablePath?: string
  developmentRoot?: string
}

function runtimeValues(input: NodeDataDirRuntime): {
  platform: NodeJS.Platform
  homeDir: string
} {
  return {
    platform: input.platform ?? process.platform,
    homeDir: input.homeDir ?? homedir()
  }
}

/** Shared installation metadata stays compatible with the Electron entry point. */
export function resolveNodeBootstrapRoot(input: NodeDataDirRuntime = {}): string {
  const runtime = runtimeValues(input)
  if (runtime.platform === 'win32') {
    return join(runtime.homeDir, 'AppData', 'Roaming', 'CodeTask')
  }
  return join(runtime.homeDir, '.config', 'codetask')
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

function resolveNodeDevelopmentRoot(): string {
  let current = process.argv[1] ? dirname(resolve(process.argv[1])) : process.cwd()
  for (;;) {
    const packageJson = join(current, 'package.json')
    if (existsSync(packageJson) && isCodeTaskPackage(packageJson)) return current
    const parent = dirname(current)
    if (parent === current) return process.cwd()
    current = parent
  }
}

function runningAsSingleExecutable(): boolean {
  if (!process.argv[1]) return true
  return resolve(process.argv[1]) === resolve(process.execPath)
}

export function resolveNodeInitializationConfigPath(input: NodeDataDirRuntime = {}): string {
  return resolveInitializationConfigPath({
    isPackaged: input.isPackaged ?? runningAsSingleExecutable(),
    executablePath: input.executablePath ?? process.execPath,
    developmentRoot: input.developmentRoot ?? resolveNodeDevelopmentRoot()
  })
}

/** Both Electron and Node read dbPath from the same initialization-file contract. */
export function resolveNodeDefaultDataDir(input: NodeDataDirRuntime = {}): string {
  return readInitializationConfig(resolveNodeInitializationConfigPath(input)).dbPath
}

export function resolveNodeDataDirSelection(
  input: {
    explicitDataDir?: string
    mode: AppMode
    bootstrapRoot?: string
    defaultDataDir?: string
  },
  runtime: NodeDataDirRuntime = {}
): DataDirResolution {
  const defaultDataDir =
    input.defaultDataDir ?? (input.explicitDataDir ? '' : resolveNodeDefaultDataDir(runtime))
  return resolveStorageLocation({
    explicitDataDir: input.explicitDataDir,
    configuredDataDir: input.explicitDataDir ? undefined : defaultDataDir,
    mode: input.mode,
    bootstrapRoot: input.bootstrapRoot ?? resolveNodeBootstrapRoot(runtime),
    defaultDataDir
  })
}
