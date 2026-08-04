import { join, posix } from 'path'

/**
 * Central path resolver for everything under the app data directory.
 * All writers/readers of data/ subpaths must go through this module.
 *
 * Durable product storage is db + attachments (+ artifacts). Legacy
 * `runtimes/` trees are no longer created; cleanup may still wipe them.
 */
export function dataPaths(dataDir: string): {
  dbFile: string
  attachments: string
  artifactsMessages: string
  artifactsJobs: string
  sandboxHome: string
} {
  return {
    dbFile: join(dataDir, 'db', 'app.db'),
    attachments: join(dataDir, 'assets', 'attachments'),
    artifactsMessages: join(dataDir, 'assets', 'artifacts', 'messages'),
    artifactsJobs: join(dataDir, 'assets', 'artifacts', 'jobs'),
    sandboxHome: join(dataDir, 'sandbox-home')
  }
}

/** DB-stored relative paths use POSIX separators. */
export function messageArtifactRelPath(messageId: string, artifactId: string): string {
  return posix.join('assets', 'artifacts', 'messages', messageId, `${artifactId}.json.gz`)
}

export function jobArtifactRelPath(contentHash: string): string {
  return posix.join(
    'assets',
    'artifacts',
    'jobs',
    contentHash.slice(0, 2),
    `${contentHash}.json.gz`
  )
}

export function threadAttachmentsDir(dataDir: string, threadId: string): string {
  return join(dataPaths(dataDir).attachments, threadId)
}

export function attachmentDir(dataDir: string, threadId: string, attachmentId: string): string {
  return join(dataPaths(dataDir).attachments, threadId, attachmentId)
}

/**
 * Resolve an assets.storage_key to an absolute directory under dataDir/assets.
 * storage_key uses POSIX form like `attachments/{ownerId}/{assetId}`.
 */
export function resolveAssetStoragePath(dataDir: string, storageKey: string): string {
  const normalized = storageKey.replace(/^\/+/, '').split('/').filter(Boolean)
  if (normalized.length === 0) {
    throw new Error('storage_key must not be empty')
  }
  return join(dataDir, 'assets', ...normalized)
}

/** Canonical attachment storage_key (no filename). */
export function attachmentStorageKey(ownerId: string, assetId: string): string {
  return posix.join('attachments', ownerId, assetId)
}

export function messageArtifactDir(dataDir: string, messageId: string): string {
  return join(dataPaths(dataDir).artifactsMessages, messageId)
}
