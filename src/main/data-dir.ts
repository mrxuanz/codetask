import { existsSync, mkdirSync, readFileSync } from 'fs'
import { app } from 'electron'
import { dirname, join, resolve } from 'path'
import { homedir } from 'os'
import type { AppMode } from './cli'
import { resolveStorageLocation, type DataDirResolution } from './storage-locator'

/**
 * Resolve the project root that should own the development `data/` directory.
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

export type { DataDirResolution, DataDirSource } from './storage-locator'

export function resolveBootstrapRoot(mode: AppMode, override?: string): string {
  const configured = override?.trim() || process.env.CODETASK_BOOTSTRAP_ROOT?.trim()
  if (configured) return resolve(configured)
  if (mode === 'desktop') return app.getPath('userData')
  if (process.platform === 'win32') {
    return join(process.env.APPDATA?.trim() || app.getPath('userData'), 'CodeTask')
  }
  return join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'), 'codetask')
}

export function resolveDefaultDataDir(): string {
  // Packaged applications may live in read-only AppImage mounts, /opt, Program Files, or a signed
  // macOS bundle. Electron userData is writable, stable across upgrades, and scoped per OS user.
  if (app.isPackaged) return join(app.getPath('userData'), 'data')
  return join(resolveDevAppRoot(), 'data')
}

export function resolveDataDirSelection(input: {
  explicitDataDir?: string
  mode: AppMode
  bootstrapRoot?: string
  defaultDataDir?: string
}): DataDirResolution {
  return resolveStorageLocation({
    explicitDataDir: input.explicitDataDir,
    envDataDir: process.env.CODETASK_DATA_DIR,
    mode: input.mode,
    bootstrapRoot: resolveBootstrapRoot(input.mode, input.bootstrapRoot),
    defaultDataDir: input.defaultDataDir ?? resolveDefaultDataDir()
  })
}

export function resolveDataDir(explicitDataDir?: string): string {
  const configured = explicitDataDir?.trim() || process.env.CODETASK_DATA_DIR?.trim()
  if (configured) return resolve(configured)
  return resolveDefaultDataDir()
}

export function ensureDataDir(explicitDataDir?: string): string {
  const dir = resolveDataDir(explicitDataDir)
  mkdirSync(dir, { recursive: true })
  return dir
}
