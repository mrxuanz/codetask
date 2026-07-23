import { dirname, normalize, parse } from 'path'
import { existsSync, realpathSync, statSync } from 'fs'
import type { SupportedCoreCode } from '../conversation/cores'
import { getProviderRegistry } from '../providers/access'
import { providerInstallationResolver } from '../providers/installation'
import { processHostEnvironmentSource, type HostEnvironmentSnapshot } from '../host-environment'
import { resolveHostNodeBinDirs, resolveToolchainContainerRoot } from './toolchain-path'

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

  for (const dir of resolveHostNodeBinDirs({
    env: hostEnvironment
  })) {
    addRoot(roots, dir)
    addRoot(roots, resolveToolchainContainerRoot(dir))
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

  // Prefer unified installation resolution so entry/canonical read roots match launch.
  const installation = providerInstallationResolver.resolve(provider, {
    hostEnv: hostEnvironment,
    settings: driver.settings,
    installDirs
  })
  if (installation) {
    for (const path of [installation.resolvedPath, installation.canonicalPath]) {
      const dir = existingDirectoryFor(path)
      addRoot(roots, dir)
      addRoot(roots, dir ? resolveToolchainContainerRoot(dir) : null)
    }
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
