import { existsSync, readFileSync } from 'fs'
import { app } from 'electron'
import { dirname, join, resolve } from 'path'
import { dataDirFromDbPath, type DataDirResolution } from './storage-selection'
import {
  ensureInitializationConfig,
  resolveInitializationConfigPath,
  resolveInitializationDefaultDataDir,
  writeInitializationConfig
} from './initialization-config'

/**
 * Resolve the project root that owns the development initialization config and default candidate.
 */
function resolveDevAppRoot(): string {
  // electron-vite may place the main entry under out/main/ or out/main/chunks/.
  // Walk upward until we find this repo's package.json.
  let dir = __dirname
  for (;;) {
    const packageJsonPath = join(dir, 'package.json')
    if (existsSync(packageJsonPath) && isAppPackageJson(packageJsonPath)) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  // Fallback: electron-vite usually reports the project root here.
  return app.getAppPath()
}

function isAppPackageJson(packageJsonPath: string): boolean {
  try {
    const raw = readFileSync(packageJsonPath, 'utf8')
    const pkg = JSON.parse(raw) as { name?: unknown; main?: unknown }
    return pkg.main === './out/main/index.js' || pkg.name === 'task'
  } catch {
    return false
  }
}

export type { DataDirResolution, DataDirSource } from './storage-selection'

export function resolveDataInitializationConfigPath(): string {
  return resolveInitializationConfigPath({
    isPackaged: app.isPackaged,
    executablePath: app.getPath('exe'),
    developmentRoot: resolveDevAppRoot()
  })
}

export function writeDataInitializationConfig(dataDir: string): string {
  const dbPath = join(resolve(dataDir), 'db', 'app.db')
  return writeInitializationConfig(resolveDataInitializationConfigPath(), dbPath).dbPath
}

export function resolveDataDirSelection(
  input: {
    defaultDataDir?: string
  } = {}
): DataDirResolution {
  const configPath = resolveDataInitializationConfigPath()
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
