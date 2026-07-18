import { createHash } from 'crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import type { SupportedCoreCode } from '../../conversation/cores'

export const CREDENTIAL_SNAPSHOT_MANIFEST = 'credential-snapshot-manifest.json'

interface CredentialSnapshotEntry {
  path: string
  sha256: string
}

interface CredentialSnapshotManifest {
  schemaVersion: 1
  provider: SupportedCoreCode
  createdAt: string
  files: CredentialSnapshotEntry[]
}

export interface CredentialSnapshotScrubResult {
  manifests: number
  files: number
  rejectedPaths: number
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function manifestPath(runtimeRoot: string): string {
  return join(runtimeRoot, CREDENTIAL_SNAPSHOT_MANIFEST)
}

/**
 * Durably records exactly which files were copied from a host Provider profile. Startup cleanup
 * only trusts paths in this manifest and never searches workspaces by credential-like filenames.
 */
export function writeCredentialSnapshotManifest(
  runtimeRoot: string,
  provider: SupportedCoreCode,
  absolutePaths: readonly string[]
): string | null {
  const root = resolve(runtimeRoot)
  const files: CredentialSnapshotEntry[] = []

  for (const path of absolutePaths) {
    const absolute = resolve(path)
    if (!existsSync(absolute) || !isPathInside(root, absolute)) continue
    try {
      if (!lstatSync(absolute).isFile()) continue
      files.push({
        path: relative(root, absolute).split(sep).join('/'),
        sha256: sha256File(absolute)
      })
    } catch {
      // A snapshot that disappeared before the manifest write needs no cleanup.
    }
  }

  if (files.length === 0) return null

  const manifest: CredentialSnapshotManifest = {
    schemaVersion: 1,
    provider,
    createdAt: new Date().toISOString(),
    files
  }
  const path = manifestPath(root)
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  if (process.platform !== 'win32') chmodSync(tmp, 0o600)
  renameSync(tmp, path)
  return path
}

function readManifest(path: string): CredentialSnapshotManifest | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<CredentialSnapshotManifest>
    if (
      value.schemaVersion !== 1 ||
      typeof value.provider !== 'string' ||
      !Array.isArray(value.files)
    ) {
      return null
    }
    return value as CredentialSnapshotManifest
  } catch {
    return null
  }
}

export function scrubCredentialSnapshotManifest(
  runtimeRoot: string
): CredentialSnapshotScrubResult {
  const root = resolve(runtimeRoot)
  const path = manifestPath(root)
  const result: CredentialSnapshotScrubResult = { manifests: 0, files: 0, rejectedPaths: 0 }
  if (!existsSync(path)) return result

  const manifest = readManifest(path)
  if (!manifest) {
    // A malformed marker is retained for diagnostics. Do not guess which files are credentials.
    return result
  }

  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || isAbsolute(entry.path)) {
      result.rejectedPaths += 1
      continue
    }
    const target = resolve(root, entry.path)
    if (!isPathInside(root, target)) {
      result.rejectedPaths += 1
      continue
    }
    try {
      if (existsSync(target) && lstatSync(target).isFile()) {
        unlinkSync(target)
        result.files += 1
      }
    } catch {
      // Keep the manifest so the next startup can retry the scrub.
      return result
    }
  }

  try {
    unlinkSync(path)
    result.manifests = 1
  } catch {
    // A later pass will retry removing the marker.
  }
  return result
}

/** Scrub manifests under the trusted runtime tree without following directory symlinks. */
export function scrubCredentialSnapshotsInTree(runtimeTree: string): CredentialSnapshotScrubResult {
  const total: CredentialSnapshotScrubResult = { manifests: 0, files: 0, rejectedPaths: 0 }
  if (!existsSync(runtimeTree)) return total

  const visit = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    if (entries.some((entry) => entry.isFile() && entry.name === CREDENTIAL_SNAPSHOT_MANIFEST)) {
      const result = scrubCredentialSnapshotManifest(dir)
      total.manifests += result.manifests
      total.files += result.files
      total.rejectedPaths += result.rejectedPaths
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      visit(join(dir, entry.name))
    }
  }

  visit(resolve(runtimeTree))
  return total
}

export function credentialSnapshotManifestPath(runtimeRoot: string): string {
  return manifestPath(resolve(runtimeRoot))
}
