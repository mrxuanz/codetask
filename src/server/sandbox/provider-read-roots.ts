import { execFileSync } from 'child_process'
import { dirname, normalize, parse, sep } from 'path'
import { existsSync, realpathSync, statSync } from 'fs'
import type { SupportedCoreCode } from '../conversation/cores'
import { resolveProviderExecutable } from '../providers/executable'
import { getProviderRegistry } from '../providers/access'
import {
  processHostEnvironmentSource,
  type HostEnvironmentSnapshot
} from '../host-environment'
import { resolveHostNodeBinDirs } from './toolchain-path'

const TOOL_HOME_ENV_KEYS = ['VOLTA_HOME', 'NVM_SYMLINK'] as const

function whereNode(hostEnvironment: HostEnvironmentSnapshot): string[] {
  if (process.platform === 'win32') {
    try {
      const output = execFileSync('where', ['node'], {
        encoding: 'utf8',
        env: { ...hostEnvironment },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })
      return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    } catch {
      return []
    }
  }

  try {
    const output = execFileSync('which', ['node'], {
      encoding: 'utf8',
      env: { ...hostEnvironment },
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const line = output.trim()
    return line ? [line] : []
  } catch {
    return []
  }
}

function safeRealpath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    try {
      return realpathSync(path)
    } catch {
      return normalize(path)
    }
  }
}

function existingDirectoryFor(path: string): string | null {
  const clean = path.trim().replace(/^"|"$/g, '')
  if (!clean || !existsSync(clean)) return null
  try {
    const stat = statSync(clean)
    return normalize(stat.isDirectory() ? clean : dirname(clean))
  } catch {
    return null
  }
}

function ancestorNamed(path: string, segment: string): string | null {
  const normalized = normalize(path)
  const parsed = parse(normalized)
  const parts = normalized
    .slice(parsed.root.length)
    .split(/[\\/]+/)
    .filter(Boolean)
  const expected = segment.toLowerCase()
  const index = parts.findIndex((part) => {
    const candidate = part.toLowerCase()
    return candidate === expected || candidate === `.${expected}`
  })
  if (index === -1) return null
  return safeRealpath(`${parsed.root}${parts.slice(0, index + 1).join(sep)}`)
}

function isSafeReadRoot(path: string): boolean {
  const normalized = normalize(path)
  const root = parse(normalized).root
  return normalized.toLowerCase() !== root.toLowerCase()
}

function addRoot(roots: Map<string, string>, path: string | null | undefined): void {
  if (!path || !existsSync(path) || !isSafeReadRoot(path)) return
  const normalized = normalize(path)
  roots.set(normalized.toLowerCase(), normalized)

  const real = safeRealpath(normalized)
  if (isSafeReadRoot(real)) {
    roots.set(real.toLowerCase(), real)
  }
  if (real.toLowerCase() !== normalized.toLowerCase()) {
    const parent = dirname(normalized)
    if (isSafeReadRoot(parent)) {
      roots.set(parent.toLowerCase(), parent)
    }
  }
}

/** Host toolchain roots shared by every Provider (no Provider switch). */
export function resolveHostToolchainReadRoots(
  hostEnvironment: HostEnvironmentSnapshot = processHostEnvironmentSource.snapshot()
): string[] {
  const roots = new Map<string, string>()

  for (const candidate of whereNode(hostEnvironment)) {
    const dir = existingDirectoryFor(candidate)
    addRoot(roots, dir)
    addRoot(roots, dir ? ancestorNamed(dir, 'Volta') : null)
  }

  for (const key of TOOL_HOME_ENV_KEYS) {
    addRoot(roots, hostEnvironment[key])
  }
  const hostHome = hostEnvironment.HOME ?? hostEnvironment.USERPROFILE
  for (const dir of resolveHostNodeBinDirs({
    env: hostEnvironment,
    ...(hostHome ? { hostHome } : {})
  })) {
    addRoot(roots, dir)
    addRoot(roots, ancestorNamed(dir, 'Volta'))
  }

  return [...roots.values()]
}

/**
 * Compatibility helper for diagnostics. Production orchestration merges the
 * selected driver's contribution directly.
 */
export function resolveProviderReadRoots(
  provider: SupportedCoreCode,
  hostEnvironment: HostEnvironmentSnapshot = processHostEnvironmentSource.snapshot()
): string[] {
  const roots = new Map<string, string>()
  const driver = getProviderRegistry().get(provider)
  const installDirs = driver.installDirs(hostEnvironment)

  for (const path of resolveHostToolchainReadRoots(hostEnvironment)) {
    addRoot(roots, path)
  }

  // Prefer unified resolver so detect/launch/read-roots share one path.
  const resolved = resolveProviderExecutable(provider, {
    env: hostEnvironment,
    settings: driver.settings,
    installDirs
  })
  if (resolved) {
    const dir = existingDirectoryFor(resolved.executable)
    addRoot(roots, dir)
    addRoot(roots, dir ? ancestorNamed(dir, 'Volta') : null)
  }

  for (const dir of installDirs) {
    addRoot(roots, dir)
  }

  return [...roots.values()]
}

export function mergeProviderReadRoots(base: string[], extra: string[]): string[] {
  const roots = new Map<string, string>()
  for (const path of [...base, ...extra]) {
    addRoot(roots, path)
  }
  return [...roots.values()]
}
