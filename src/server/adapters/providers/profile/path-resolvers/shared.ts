import { isAbsolute, normalize, resolve } from 'node:path'
import type { ProviderProfileCode } from '../types.ts'
import {
  PathResolverError,
  type HostEnv,
  type HostRoots,
  type ProviderIdentityPaths
} from './types.ts'

export function requireHome(env: HostEnv, fallbackKeys: readonly string[]): string {
  for (const key of fallbackKeys) {
    const value = env[key]?.trim()
    if (value) return normalize(resolve(value))
  }
  throw new PathResolverError(
    'Unable to resolve user home directory from host environment',
    'profile.path.home_missing'
  )
}

export function assertNotWholeHome(candidate: string, roots: HostRoots): void {
  const normalized = normalize(resolve(candidate))
  if (!isAbsolute(normalized)) {
    throw new PathResolverError(
      `Identity path must be absolute: ${candidate}`,
      'profile.path.not_absolute'
    )
  }
  if (normalized.includes('$') || normalized.includes('%')) {
    throw new PathResolverError(
      `Unexpanded variable in identity path: ${candidate}`,
      'profile.path.unexpanded'
    )
  }

  const home = normalize(resolve(roots.home))
  const dangerous = new Set([
    home.toLowerCase(),
    normalize(resolve('/')).toLowerCase(),
    'c:\\',
    'c:/'
  ])
  if (dangerous.has(normalized.toLowerCase())) {
    throw new PathResolverError(
      `Whole HOME / profile / disk root is forbidden as identity path: ${candidate}`,
      'profile.path.whole_home_forbidden'
    )
  }
}

export function ensureUnderHome(candidate: string, roots: HostRoots): string {
  // Reject whole HOME / disk roots; precise AppData / XDG identity dirs are allowed.
  assertNotWholeHome(candidate, roots)
  return normalize(resolve(candidate))
}

export function emptyIdentity(provider: ProviderProfileCode): ProviderIdentityPaths {
  return {
    provider,
    credentialFiles: [],
    credentialDirs: [],
    configDirs: []
  }
}

/** Shared Codex / Claude / Cursor / OpenCode identity layout keyed by HostRoots. */
export function resolveCommonIdentity(
  provider: ProviderProfileCode,
  roots: HostRoots,
  layout: {
    readonly credentialFiles: readonly string[]
    readonly credentialDirs: readonly string[]
    readonly configDirs: readonly string[]
  }
): ProviderIdentityPaths {
  for (const path of [
    ...layout.credentialFiles,
    ...layout.credentialDirs,
    ...layout.configDirs
  ]) {
    ensureUnderHome(path, roots)
  }
  return {
    provider,
    credentialFiles: layout.credentialFiles.map((p) => normalize(resolve(p))),
    credentialDirs: layout.credentialDirs.map((p) => normalize(resolve(p))),
    configDirs: layout.configDirs.map((p) => normalize(resolve(p)))
  }
}
