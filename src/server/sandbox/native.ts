import { createRequire } from 'module'
import { existsSync } from 'fs'
import { join } from 'path'
import { processHostEnvironmentSource } from '../host-environment'
import { SandboxError } from './types'
import type { CodeteamSandboxNative } from './types'

const require = createRequire(__filename)

function getResourcesPath(): string | undefined {
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
}

function packagedAppPath(): string | null {
  const resourcesPath = getResourcesPath()
  if (!resourcesPath) return null
  const asarPath = join(resourcesPath, 'app.asar')
  return existsSync(asarPath) ? asarPath : null
}

function resolveAddonDir(): string | null {
  const paths: string[] = []
  const hostEnv = processHostEnvironmentSource.snapshot()

  if (hostEnv.CODETEAM_SANDBOX_NATIVE?.trim()) {
    paths.push(hostEnv.CODETEAM_SANDBOX_NATIVE.trim())
  }

  const appPath = packagedAppPath()
  const resourcesPath = getResourcesPath()
  if (appPath && resourcesPath) {
    paths.push(join(resourcesPath, 'app.asar.unpacked', 'native', 'codeteam-sandbox'))
    paths.push(join(appPath, 'native', 'codeteam-sandbox'))
    paths.push(join(resourcesPath, 'native', 'codeteam-sandbox'))
  }

  paths.push(join(__dirname, '..', '..', '..', 'native', 'codeteam-sandbox'))
  paths.push(join(process.cwd(), 'native', 'codeteam-sandbox'))

  for (const dir of paths) {
    if (existsSync(join(dir, 'index.js'))) return dir
  }

  return null
}

let cached: CodeteamSandboxNative | null = null

export function tryLoadSandboxNative(): CodeteamSandboxNative | null {
  if (cached) return cached
  const dir = resolveAddonDir()
  if (!dir) return null
  try {
    cached = require(join(dir, 'index.js')) as CodeteamSandboxNative
    return cached
  } catch {
    return null
  }
}

export function loadSandboxNative(): CodeteamSandboxNative {
  const native = tryLoadSandboxNative()
  if (!native) {
    throw new SandboxError(
      'Sandbox native addon not found; run npm run build:sandbox',
      'sandbox.native.missing'
    )
  }
  return native
}

export function resolveSetupEntryScript(): string {
  const dir = resolveAddonDir()
  if (!dir) {
    throw new SandboxError(
      'Sandbox native addon not found; run npm run build:sandbox',
      'sandbox.native.missing'
    )
  }
  return join(dir, 'setup-entry.js')
}

export function resolveRunnerEntryScript(): string {
  const dir = resolveAddonDir()
  if (!dir) {
    throw new SandboxError(
      'Sandbox native addon not found; run npm run build:sandbox',
      'sandbox.native.missing'
    )
  }
  return join(dir, 'runner-entry.js')
}
