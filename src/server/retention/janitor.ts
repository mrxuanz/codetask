import { existsSync } from 'fs'
import { readdir, rm } from 'fs/promises'
import { join } from 'path'
import { eq } from 'drizzle-orm'
import { parseJobReferenceManifest } from '../../shared/job-references.ts'
import type { getDb } from '../db'
import { jobArtifacts, messageArtifacts } from '../db/schema'

import { dataPaths, resolveAssetStoragePath, threadAttachmentsDir } from '../data-paths'
import {
  finalizeAssetDeleted,
  listPendingDeleteAssets,
  markAssetDeleteFailed
} from '../assets/registry'
import { wipeLegacyRuntimesRoot } from '../runtime/cleanup'

type AppDatabase = ReturnType<typeof getDb>

function sqliteClient(db: AppDatabase): import('better-sqlite3').Database | null {
  return (db as AppDatabase & { $client?: import('better-sqlite3').Database }).$client ?? null
}

function tableExists(client: import('better-sqlite3').Database, name: string): boolean {
  const row = client
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { 1: number } | undefined
  return Boolean(row)
}

/** Legitimate attachment owner dirs: Conversation + asset_references. */
function collectValidAttachmentOwnerIds(db: AppDatabase): Set<string> {
  const valid = new Set<string>()
  const client = sqliteClient(db)
  if (client && tableExists(client, 'conversation_threads')) {
    try {
      const rows = client.prepare(`SELECT id FROM conversation_threads`).all() as Array<{
        id: string
      }>
      for (const row of rows) valid.add(row.id)
    } catch {
      // conversation tables may be absent in narrow fixtures
    }
  }
  if (client && tableExists(client, 'asset_references')) {
    try {
      const rows = client
        .prepare(
          `SELECT DISTINCT owner_id AS ownerId
             FROM asset_references
            WHERE owner_type IN ('conversation', 'thread')`
        )
        .all() as Array<{ ownerId: string }>
      for (const row of rows) valid.add(row.ownerId)
    } catch {
      // asset tables may be absent pre-062
    }
  }
  return valid
}

function collectConversationAttachmentIds(db: AppDatabase, conversationId: string): string[] {
  const client = sqliteClient(db)
  if (!client || !tableExists(client, 'conversation_message_attachments')) return []
  try {
    const rows = client
      .prepare(
        `SELECT id, asset_id AS assetId
         FROM conversation_message_attachments
         WHERE conversation_id = ?`
      )
      .all(conversationId) as Array<{ id: string; assetId: string }>
    const ids: string[] = []
    for (const row of rows) {
      if (row.id) ids.push(row.id)
      if (row.assetId) ids.push(row.assetId)
    }
    return ids
  } catch {
    return []
  }
}

export async function removeThreadAttachmentsDir(
  dataDir: string,
  threadId: string
): Promise<boolean> {
  const path = threadAttachmentsDir(dataDir, threadId)
  if (!existsSync(path)) return false
  await rm(path, { recursive: true, force: true })
  return true
}

/** Async file delete for assets in pending_delete (Batch G2). */
export async function processPendingAssetDeletes(
  dataDir: string,
  db: AppDatabase
): Promise<{ removed: number; failed: number }> {
  const client = sqliteClient(db)
  if (!client) return { removed: 0, failed: 0 }

  let removed = 0
  let failed = 0
  for (const asset of listPendingDeleteAssets(client)) {
    try {
      const absolute = resolveAssetStoragePath(dataDir, asset.storageKey)
      if (existsSync(absolute)) {
        await rm(absolute, { recursive: true, force: true })
      }
      finalizeAssetDeleted(client, asset.id)
      removed += 1
    } catch (error) {
      markAssetDeleteFailed(
        client,
        asset.id,
        error instanceof Error ? error.message : String(error)
      )
      failed += 1
    }
  }
  return { removed, failed }
}

export async function pruneOrphanAttachments(
  dataDir: string,
  db: AppDatabase
): Promise<{ removed: number }> {
  const root = dataPaths(dataDir).attachments
  if (!existsSync(root)) return { removed: 0 }

  const valid = collectValidAttachmentOwnerIds(db)
  let removed = 0

  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (valid.has(entry.name)) continue
    await rm(join(root, entry.name), { recursive: true, force: true })
    removed += 1
  }

  return { removed }
}

/** One-shot wipe of leftover data/runtimes (product no longer creates this tree). */
export async function wipeLegacyProductRuntimes(dataDir: string): Promise<{ removed: number }> {
  return wipeLegacyRuntimesRoot(dataDir)
}

export async function pruneOrphanMessageArtifactDirs(
  dataDir: string,
  db: AppDatabase
): Promise<{ removed: number }> {
  const root = dataPaths(dataDir).artifactsMessages
  if (!existsSync(root)) return { removed: 0 }

  const rows = await db.select({ messageId: messageArtifacts.messageId }).from(messageArtifacts)
  const valid = new Set(rows.map((row) => row.messageId))
  let removed = 0

  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (valid.has(entry.name)) continue
    await rm(join(root, entry.name), { recursive: true, force: true })
    removed += 1
  }

  return { removed }
}

export async function pruneOrphanJobArtifactFiles(
  dataDir: string,
  db: AppDatabase
): Promise<{ removed: number }> {
  const root = dataPaths(dataDir).artifactsJobs
  if (!existsSync(root)) return { removed: 0 }
  const rows = await db
    .select({ contentPath: jobArtifacts.contentPath })
    .from(jobArtifacts)
    .where(eq(jobArtifacts.storage, 'file'))
  const valid = new Set(
    rows.flatMap((row) => (row.contentPath ? [join(dataDir, row.contentPath)] : []))
  )
  let removed = 0

  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await visit(path)
        await rm(path, { recursive: false }).catch(() => {})
      } else if (entry.isFile() && !valid.has(path)) {
        await rm(path, { force: true })
        removed += 1
      }
    }
  }
  await visit(root)
  return { removed }
}

/** Collect Design + Execution attachment ids for a conversation's project. */
function collectProjectScopedAttachmentIds(db: AppDatabase, conversationId: string): string[] {
  const client = sqliteClient(db)
  if (!client) return []
  const ids: string[] = []
  try {
    const designRows = client
      .prepare(
        `SELECT dr.attachment_id AS attachmentId
         FROM design_draft_references dr
         JOIN drafts d ON d.id = dr.draft_id
         JOIN conversation_threads ct ON ct.project_id = d.project_id
         WHERE ct.id = ? AND dr.attachment_id IS NOT NULL`
      )
      .all(conversationId) as Array<{ attachmentId: string }>
    for (const row of designRows) ids.push(row.attachmentId)
  } catch {
    // design tables may be absent in narrow fixtures
  }
  try {
    const jobRows = client
      .prepare(
        `SELECT js.reference_manifest_json AS referenceManifestJson
         FROM job_snapshots js
         JOIN jobs j ON j.id = js.job_id
         JOIN conversation_threads ct ON ct.project_id = j.project_id
         WHERE ct.id = ?`
      )
      .all(conversationId) as Array<{ referenceManifestJson: string }>
    for (const row of jobRows) {
      const manifest = parseJobReferenceManifest(row.referenceManifestJson)
      for (const reference of manifest?.references ?? []) {
        if (reference.storageOwner === 'job' && reference.attachmentId) {
          ids.push(reference.attachmentId)
        }
      }
    }
  } catch {
    // execution tables may be absent in narrow fixtures
  }
  return ids
}

export async function pruneStaleThreadAttachmentDirs(
  dataDir: string,
  db: AppDatabase
): Promise<{ removed: number }> {
  const attachmentsRoot = dataPaths(dataDir).attachments
  if (!existsSync(attachmentsRoot)) return { removed: 0 }

  const client = sqliteClient(db)
  const conversationIds: string[] = []
  if (client && tableExists(client, 'conversation_threads')) {
    try {
      const rows = client.prepare(`SELECT id FROM conversation_threads`).all() as Array<{
        id: string
      }>
      for (const row of rows) conversationIds.push(row.id)
    } catch {
      // narrow fixtures
    }
  }

  let removed = 0

  for (const conversationId of conversationIds) {
    const threadDir = join(attachmentsRoot, conversationId)
    if (!existsSync(threadDir)) continue

    const validAttachmentIds = new Set<string>(
      collectProjectScopedAttachmentIds(db, conversationId)
    )
    for (const id of collectConversationAttachmentIds(db, conversationId)) {
      validAttachmentIds.add(id)
    }

    for (const entry of await readdir(threadDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (validAttachmentIds.has(entry.name)) continue
      await rm(join(threadDir, entry.name), { recursive: true, force: true })
      removed += 1
    }
  }

  return { removed }
}
