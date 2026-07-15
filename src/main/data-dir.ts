import { existsSync, mkdirSync, readFileSync } from 'fs'
import { app } from 'electron'
import { dirname, join } from 'path'

/**
 * Resolve the application root that should own the `data/` directory.
 *
 * - Dev: project root (walk up from the compiled main entry until package.json).
 * - Packaged: install/program root (parent of `resources/`), not Electron userData.
 */
function resolveAppRoot(): string {
  if (app.isPackaged) {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    if (resourcesPath) {
      return dirname(resourcesPath)
    }
    return dirname(app.getPath('exe'))
  }

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

export function resolveDataDir(): string {
  const fromEnv = process.env.CODETASK_DATA_DIR?.trim()
  if (fromEnv) return fromEnv
  return join(resolveAppRoot(), 'data')
}

export function ensureDataDir(): string {
  const dir = resolveDataDir()
  mkdirSync(dir, { recursive: true })
  return dir
}
