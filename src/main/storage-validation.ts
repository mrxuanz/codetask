import { randomUUID } from 'crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync
} from 'fs'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'path'
import { homedir } from 'os'
import Database from 'better-sqlite3'
import { readDataRootMarker } from './storage-locator'
import { dataPaths } from '../server/data-paths'

const DEFAULT_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024

export interface StorageTargetValidation {
  ok: boolean
  canonicalPath: string
  availableBytes: number | null
  warnings: string[]
  issue?: string
  nonce?: string
}

interface ValidationGrant {
  canonicalPath: string
  expiresAt: number
}

export class StorageValidationNonceRepository {
  private readonly grants = new Map<string, ValidationGrant>()

  issue(canonicalPath: string, ttlMs = 5 * 60_000): string {
    const nonce = randomUUID()
    this.grants.set(nonce, { canonicalPath, expiresAt: Date.now() + ttlMs })
    return nonce
  }

  consume(nonce: string, canonicalPath: string): boolean {
    const grant = this.grants.get(nonce)
    this.grants.delete(nonce)
    return Boolean(grant && grant.expiresAt >= Date.now() && grant.canonicalPath === canonicalPath)
  }
}

function canonicalizeProspectivePath(path: string): string {
  let cursor = resolve(path)
  const missing: string[] = []
  while (!existsSync(cursor)) {
    const parent = dirname(cursor)
    if (parent === cursor) throw new Error('No existing parent directory')
    missing.unshift(basename(cursor))
    cursor = parent
  }
  const realParent = realpathSync.native(cursor)
  return resolve(realParent, ...missing)
}

function samePath(a: string, b: string): boolean {
  const canonical = (path: string): string => {
    const absolute = resolve(path)
    if (!existsSync(absolute)) return absolute
    try {
      return realpathSync.native(absolute)
    } catch {
      return absolute
    }
  }
  const left = canonical(a)
  const right = canonical(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function directoryIsEmpty(path: string): boolean {
  return statSync(path).isDirectory() && readdirSync(path).length === 0
}

function testAtomicWrites(target: string): void {
  const probeParent = existsSync(target) ? target : dirname(target)
  const probeDir = join(probeParent, `.codetask-storage-probe-${randomUUID()}`)
  const source = join(probeDir, 'source')
  const destination = join(probeDir, 'destination')
  mkdirSync(probeDir, { recursive: false, mode: 0o700 })
  let fd: number | null = null
  try {
    writeFileSync(source, 'probe', { mode: 0o600 })
    fd = openSync(source, 'r')
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(source, destination)
  } finally {
    if (fd !== null) closeSync(fd)
    rmSync(probeDir, { recursive: true, force: true })
  }
}

export function validateStorageTarget(input: {
  path: string
  forbiddenRoots?: readonly string[]
  expectedInstallationId?: string
  minFreeBytes?: number
  allowLowSpace?: boolean
  nonceRepository?: StorageValidationNonceRepository
}): StorageTargetValidation {
  const raw = input.path.trim()
  if (!raw || !isAbsolute(raw)) {
    return {
      ok: false,
      canonicalPath: raw,
      availableBytes: null,
      warnings: [],
      issue: 'path_not_absolute'
    }
  }
  if (raw.split(/[\\/]+/).includes('..')) {
    return {
      ok: false,
      canonicalPath: raw,
      availableBytes: null,
      warnings: [],
      issue: 'path_parent_segment'
    }
  }
  if (existsSync(raw) && lstatSync(raw).isSymbolicLink()) {
    return {
      ok: false,
      canonicalPath: resolve(raw),
      availableBytes: null,
      warnings: [],
      issue: 'path_symlink'
    }
  }

  let canonicalPath: string
  try {
    canonicalPath = canonicalizeProspectivePath(raw)
  } catch {
    return {
      ok: false,
      canonicalPath: resolve(raw),
      availableBytes: null,
      warnings: [],
      issue: 'path_unresolvable'
    }
  }

  const root = parse(canonicalPath).root
  const forbidden = [homedir(), ...(input.forbiddenRoots ?? [])]
  if (samePath(canonicalPath, root) || forbidden.some((path) => samePath(canonicalPath, path))) {
    return {
      ok: false,
      canonicalPath,
      availableBytes: null,
      warnings: [],
      issue: 'path_forbidden_root'
    }
  }
  if (forbidden.some((path) => isInside(canonicalPath, path))) {
    return {
      ok: false,
      canonicalPath,
      availableBytes: null,
      warnings: [],
      issue: 'path_contains_forbidden_root'
    }
  }

  if (existsSync(canonicalPath)) {
    const stat = lstatSync(canonicalPath)
    if (stat.isSymbolicLink()) {
      return { ok: false, canonicalPath, availableBytes: null, warnings: [], issue: 'path_symlink' }
    }
    if (!stat.isDirectory()) {
      return {
        ok: false,
        canonicalPath,
        availableBytes: null,
        warnings: [],
        issue: 'path_not_directory'
      }
    }
    const marker = readDataRootMarker(canonicalPath)
    if (marker) {
      if (!input.expectedInstallationId || marker.installationId !== input.expectedInstallationId) {
        return {
          ok: false,
          canonicalPath,
          availableBytes: null,
          warnings: [],
          issue: 'path_owned_by_other_installation'
        }
      }
    } else if (!directoryIsEmpty(canonicalPath)) {
      return {
        ok: false,
        canonicalPath,
        availableBytes: null,
        warnings: [],
        issue: 'path_not_empty'
      }
    }
  }

  try {
    testAtomicWrites(canonicalPath)
  } catch {
    return {
      ok: false,
      canonicalPath,
      availableBytes: null,
      warnings: [],
      issue: 'path_not_writable'
    }
  }

  let availableBytes: number | null = null
  const warnings: string[] = []
  try {
    const stats = statfsSync(existsSync(canonicalPath) ? canonicalPath : dirname(canonicalPath))
    availableBytes = Number(stats.bavail) * Number(stats.bsize)
    if (availableBytes < (input.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES)) {
      if (!input.allowLowSpace) {
        return { ok: false, canonicalPath, availableBytes, warnings, issue: 'insufficient_space' }
      }
      warnings.push('low_disk_space')
    }
  } catch {
    warnings.push('free_space_unknown')
  }

  const nonce = input.nonceRepository?.issue(canonicalPath)
  return { ok: true, canonicalPath, availableBytes, warnings, ...(nonce ? { nonce } : {}) }
}

export function validateExistingStorageRoot(input: {
  path: string
  forbiddenRoots?: readonly string[]
  nonceRepository?: StorageValidationNonceRepository
}): StorageTargetValidation & { installationId?: string } {
  const marker = readDataRootMarker(input.path)
  if (!marker) {
    return {
      ok: false,
      canonicalPath: resolve(input.path),
      availableBytes: null,
      warnings: [],
      issue: 'storage_data_root_marker_missing_or_invalid'
    }
  }

  const validation = validateStorageTarget({
    path: input.path,
    forbiddenRoots: input.forbiddenRoots,
    expectedInstallationId: marker.installationId,
    minFreeBytes: 0
  })
  if (!validation.ok) return validation

  const dbFile = dataPaths(validation.canonicalPath).dbFile
  if (!existsSync(dbFile) || !statSync(dbFile).isFile()) {
    return { ...validation, ok: false, issue: 'storage_database_missing' }
  }

  let sqlite: Database.Database | null = null
  try {
    sqlite = new Database(dbFile, { readonly: true, fileMustExist: true })
    const quickCheck = sqlite.pragma('quick_check', { simple: true })
    if (quickCheck !== 'ok') {
      return { ...validation, ok: false, issue: 'storage_database_integrity_failed' }
    }
  } catch {
    return { ...validation, ok: false, issue: 'storage_database_unreadable' }
  } finally {
    sqlite?.close()
  }

  const nonce = input.nonceRepository?.issue(validation.canonicalPath)
  return {
    ...validation,
    installationId: marker.installationId,
    ...(nonce ? { nonce } : {})
  }
}
