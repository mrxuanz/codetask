import { existsSync, mkdirSync, readFileSync } from 'fs'
import { app } from 'electron'
import { dirname, join, resolve } from 'path'

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

export function resolveDataDir(explicitDataDir?: string): string {
  const configured = explicitDataDir?.trim() || process.env.CODETASK_DATA_DIR?.trim()
  if (configured) return resolve(configured)

  // Packaged applications may live in read-only AppImage mounts, /opt, Program Files, or a signed
  // macOS bundle. Electron userData is writable, stable across upgrades, and scoped per OS user.
  if (app.isPackaged) return join(app.getPath('userData'), 'data')

  return join(resolveDevAppRoot(), 'data')
}

export function ensureDataDir(explicitDataDir?: string): string {
  const dir = resolveDataDir(explicitDataDir)
  mkdirSync(dir, { recursive: true })
  return dir
}
