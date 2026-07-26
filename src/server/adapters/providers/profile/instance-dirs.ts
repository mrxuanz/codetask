import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, normalize, resolve, sep } from 'node:path'
import type { InstancePathKind, ProviderProfileCode } from './types.ts'

/**
 * Per-SDK-instance private directories (重构.md §10.3).
 *
 * Layout:
 *   {runtimeRoot}/instances/{provider}-{instanceId}/
 *     home/ config/ data/ cache/ state/ tmp/ logs/ ipc/ manifest.json
 *
 * NEW adapters must never copy credentials into these dirs.
 */

export interface InstanceDirs {
  readonly provider: ProviderProfileCode
  readonly instanceId: string
  readonly root: string
  readonly home: string
  readonly config: string
  readonly data: string
  readonly cache: string
  readonly state: string
  readonly tmp: string
  readonly log: string
  readonly ipc: string
  readonly manifestPath: string
}

export interface InstanceManifest {
  readonly version: 1
  readonly provider: ProviderProfileCode
  readonly instanceId: string
  readonly createdAtMs: number
  /** Absolute instance root; cleanup may only delete ownedPaths under this root. */
  readonly root: string
  readonly ownedPaths: readonly string[]
}

export interface AllocateInstanceDirsInput {
  readonly runtimeRoot: string
  readonly provider: ProviderProfileCode
  readonly instanceId: string
  /** When true, create directories + write manifest (default true). */
  readonly materializeFs?: boolean | undefined
  readonly nowMs?: number | undefined
}

const INSTANCE_SUBDIRS = [
  'home',
  'config',
  'data',
  'cache',
  'state',
  'tmp',
  'logs',
  'ipc'
] as const

export function instanceRootPath(
  runtimeRoot: string,
  provider: ProviderProfileCode,
  instanceId: string
): string {
  if (!provider.trim()) throw new Error('profile.instance.provider_required')
  if (!instanceId.trim()) throw new Error('profile.instance.id_required')
  return normalize(resolve(join(runtimeRoot, 'instances', `${provider}-${instanceId}`)))
}

export function allocateInstanceDirs(input: AllocateInstanceDirsInput): InstanceDirs {
  const root = instanceRootPath(input.runtimeRoot, input.provider, input.instanceId)
  const dirs: InstanceDirs = {
    provider: input.provider,
    instanceId: input.instanceId,
    root,
    home: join(root, 'home'),
    config: join(root, 'config'),
    data: join(root, 'data'),
    cache: join(root, 'cache'),
    state: join(root, 'state'),
    tmp: join(root, 'tmp'),
    log: join(root, 'logs'),
    ipc: join(root, 'ipc'),
    manifestPath: join(root, 'manifest.json')
  }

  if (input.materializeFs !== false) {
    mkdirSync(root, { recursive: true })
    for (const name of INSTANCE_SUBDIRS) {
      mkdirSync(join(root, name), { recursive: true })
    }
    const manifest: InstanceManifest = {
      version: 1,
      provider: input.provider,
      instanceId: input.instanceId,
      createdAtMs: input.nowMs ?? Date.now(),
      root,
      ownedPaths: [
        dirs.home,
        dirs.config,
        dirs.data,
        dirs.cache,
        dirs.state,
        dirs.tmp,
        dirs.log,
        dirs.ipc
      ]
    }
    writeFileSync(dirs.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }

  return dirs
}

function canonicalize(path: string): string {
  return normalize(resolve(path))
}

function isPathInsideOrEqual(candidate: string, root: string): boolean {
  const c = canonicalize(candidate)
  const r = canonicalize(root)
  if (c === r) return true
  const prefix = r.endsWith(sep) ? r : `${r}${sep}`
  return c.startsWith(prefix) || c.toLowerCase().startsWith(prefix.toLowerCase())
}

/**
 * Delete only paths listed in `manifest.ownedPaths`, and only when each path
 * resolves under `manifest.root`. Refuses host / out-of-root paths (重构.md §8.6).
 */
export function cleanupInstanceDirs(manifest: InstanceManifest): void {
  if (!manifest.root?.trim()) {
    throw new Error('profile.instance.cleanup.root_required')
  }
  const root = canonicalize(manifest.root)
  for (const owned of manifest.ownedPaths) {
    if (!owned?.trim()) continue
    const target = canonicalize(owned)
    if (!isPathInsideOrEqual(target, root)) {
      throw new Error(`profile.instance.cleanup.path_outside_root: ${owned}`)
    }
    rmSync(target, { recursive: true, force: true })
  }
}

export function pathForInstanceKind(dirs: InstanceDirs, kind: InstancePathKind): string {
  switch (kind) {
    case 'home':
      return dirs.home
    case 'config':
      return dirs.config
    case 'data':
      return dirs.data
    case 'cache':
      return dirs.cache
    case 'state':
      return dirs.state
    case 'tmp':
      return dirs.tmp
    case 'log':
      return dirs.log
    case 'ipc':
      return dirs.ipc
    default: {
      const _exhaustive: never = kind
      throw new Error(`Unknown instance path kind: ${String(_exhaustive)}`)
    }
  }
}

/** Two instance roots must not share any private subdir (multi-instance contract). */
export function assertInstanceDirsIsolated(a: InstanceDirs, b: InstanceDirs): void {
  if (a.root === b.root) {
    throw new Error('profile.instance.shared_root')
  }
  const keys = ['home', 'config', 'data', 'cache', 'state', 'tmp', 'log', 'ipc'] as const
  for (const key of keys) {
    if (a[key] === b[key]) {
      throw new Error(`profile.instance.shared_${key}`)
    }
  }
}
