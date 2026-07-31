import { existsSync, readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { dataDirFromDbPath, type DataDirResolution } from '../main/storage-selection'
import {
  ensureInitializationConfig,
  resolveInitializationConfigPath,
  resolveInitializationDefaultDataDir,
  writeInitializationConfig
} from '../main/initialization-config'

export interface NodeDataDirRuntime {
  platform?: NodeJS.Platform
  homeDir?: string
  isPackaged?: boolean
  executablePath?: string
  developmentRoot?: string
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
  const configPath = resolveNodeInitializationConfigPath(input)
  const configured = ensureInitializationConfig(configPath).dbPath
  return configured
    ? dataDirFromDbPath(configured)
    : resolveInitializationDefaultDataDir(configPath)
}

export function writeNodeDataInitializationConfig(
  dataDir: string,
  input: NodeDataDirRuntime = {}
): string {
  const dbPath = join(resolve(dataDir), 'db', 'app.db')
  return writeInitializationConfig(resolveNodeInitializationConfigPath(input), dbPath).dbPath
}

export function resolveNodeDataDirSelection(
  input: {
    defaultDataDir?: string
  } = {},
  runtime: NodeDataDirRuntime = {}
): DataDirResolution {
  const configPath = resolveNodeInitializationConfigPath(runtime)
  const initializationConfig =
    input.defaultDataDir === undefined ? ensureInitializationConfig(configPath) : { dbPath: '' }
  const defaultDataDir =
    input.defaultDataDir ??
    (initializationConfig.dbPath
      ? dataDirFromDbPath(initializationConfig.dbPath)
      : resolveInitializationDefaultDataDir(configPath))
  if (initializationConfig.dbPath) {
    return {
      phase: 'ready',
      dataDir: dataDirFromDbPath(initializationConfig.dbPath),
      source: 'config'
    }
  }
  return { phase: 'selection_required', dataDir: defaultDataDir, source: 'candidate' }
}
