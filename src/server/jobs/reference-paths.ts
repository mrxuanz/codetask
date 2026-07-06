import { join } from 'path'
import { resolveAssignedReferences, type JobReferenceManifest } from '../../shared/job-references'
import { resolveAttachmentAbsolutePath } from '../reference-corpus/paths'

export class ReferenceFileMissingError extends Error {
  constructor(
    readonly referenceId: string,
    readonly referenceName: string,
    readonly relativePath?: string
  ) {
    const detail = relativePath ? ` (${relativePath})` : ''
    super(`Reference file not found: ${referenceName} (${referenceId})${detail}`)
    this.name = 'ReferenceFileMissingError'
  }
}

export function resolveReferenceAbsolutePath(
  dataDir: string,
  threadId: string,
  relativePath: string
): string {
  try {
    return resolveAttachmentAbsolutePath(dataDir, threadId, relativePath)
  } catch {
    throw new ReferenceFileMissingError('unknown', relativePath, relativePath)
  }
}

export function assertManifestReferenceFilesExist(
  dataDir: string,
  threadId: string,
  manifest: JobReferenceManifest
): void {
  for (const entry of manifest.references) {
    if (entry.resolvedPath) {
      continue
    }
    if (!entry.relativePath) {
      throw new ReferenceFileMissingError(entry.id, entry.name)
    }
    try {
      resolveReferenceAbsolutePath(dataDir, threadId, entry.relativePath)
    } catch {
      throw new ReferenceFileMissingError(entry.id, entry.name, entry.relativePath)
    }
  }
}

export function resolveAssignedReferenceLocalPaths(
  dataDir: string,
  threadId: string,
  manifest: JobReferenceManifest,
  referenceIds: string[]
): Map<string, string> {
  const entries = resolveAssignedReferences(manifest, referenceIds)
  const found = new Set(entries.map((item) => item.id))
  const missingFromManifest = referenceIds.filter((id) => !found.has(id))
  if (missingFromManifest.length > 0) {
    throw new Error(`assigned references missing from manifest: ${missingFromManifest.join(', ')}`)
  }

  const localPathById = new Map<string, string>()
  for (const entry of entries) {
    if (entry.resolvedPath) {
      localPathById.set(entry.id, entry.resolvedPath)
      continue
    }
    if (!entry.relativePath) {
      throw new ReferenceFileMissingError(entry.id, entry.name)
    }
    try {
      localPathById.set(
        entry.id,
        resolveReferenceAbsolutePath(dataDir, threadId, entry.relativePath)
      )
    } catch {
      throw new ReferenceFileMissingError(entry.id, entry.name, entry.relativePath)
    }
  }
  return localPathById
}

export function resolveManifestEntryAbsolutePath(
  dataDir: string,
  threadId: string,
  entry: JobReferenceManifest['references'][number]
): string {
  if (entry.resolvedPath) return entry.resolvedPath
  if (!entry.relativePath) {
    throw new ReferenceFileMissingError(entry.id, entry.name)
  }
  return resolveReferenceAbsolutePath(dataDir, threadId, entry.relativePath)
}

export function attachmentIsolationDir(
  dataDir: string,
  threadId: string,
  attachmentId: string
): string {
  return join(dataDir, 'attachments', threadId, attachmentId)
}
