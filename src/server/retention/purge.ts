import { getDb } from '../db'
import { rm } from 'node:fs/promises'
import { deleteMessageArtifactFiles } from './message-artifacts'
import { processPendingAssetDeletes, removeThreadAttachmentsDirIfEmpty } from './janitor'
import { cleanupJobRuntimeTree, cleanupThreadRuntimeTree } from '../runtime/cleanup'
import { attachmentDir } from '../data-paths'

type AppDatabase = ReturnType<typeof getDb>

function sqliteClient(db: AppDatabase): import('better-sqlite3').Database | null {
  return (db as AppDatabase & { $client?: import('better-sqlite3').Database }).$client ?? null
}

export interface ThreadPurgeTargets {
  messageIds: string[]
  /** Exact physical attachment directories that had no non-Conversation owner at freeze time. */
  attachmentIds?: string[]
}

export async function collectThreadPurgeTargets(
  db: AppDatabase,
  conversationId: string
): Promise<ThreadPurgeTargets> {
  const client = sqliteClient(db)
  if (!client) return { messageIds: [], attachmentIds: [] }
  try {
    const messageRows = client
      .prepare(`SELECT id FROM conversation_messages WHERE conversation_id = ?`)
      .all(conversationId) as Array<{ id: string }>
    const attachmentRows = client
      .prepare(
        `SELECT id, asset_id AS assetId
           FROM conversation_message_attachments
          WHERE conversation_id = ?`
      )
      .all(conversationId) as Array<{ id: string; assetId: string }>
    const candidates = new Map<string, string>()
    for (const row of attachmentRows) {
      if (row.assetId) candidates.set(row.assetId, row.assetId)
      if (row.id) candidates.set(row.id, row.assetId || row.id)
    }
    try {
      const assetRows = client
        .prepare(`SELECT id FROM assets WHERE storage_key LIKE ?`)
        .all(`attachments/${conversationId}/%`) as Array<{ id: string }>
      for (const row of assetRows) candidates.set(row.id, row.id)
    } catch {
      // Pre-asset fixtures are represented by conversation_message_attachments above.
    }

    const attachmentIds: string[] = []
    for (const [physicalId, assetId] of candidates) {
      let hasOtherOwner = false
      try {
        hasOtherOwner = Boolean(
          client
            .prepare(
              `SELECT 1 AS ok
                 FROM asset_references
                WHERE asset_id = ?
                  AND NOT (owner_type IN ('conversation', 'thread') AND owner_id = ?)
                LIMIT 1`
            )
            .get(assetId, conversationId)
        )
      } catch {
        // Legacy attachment without the asset registry has only the Conversation owner.
      }
      if (!hasOtherOwner) attachmentIds.push(physicalId)
    }
    return { messageIds: messageRows.map((row) => row.id), attachmentIds }
  } catch {
    return { messageIds: [], attachmentIds: [] }
  }
}

async function removeFrozenAttachmentTargets(
  dataDir: string,
  threadId: string,
  targets: ThreadPurgeTargets
): Promise<void> {
  await Promise.all(
    (targets.attachmentIds ?? []).map((attachmentId) =>
      rm(attachmentDir(dataDir, threadId, attachmentId), { recursive: true, force: true })
    )
  )
}

export async function purgeJobFilesystem(
  dataDir: string,
  threadId: string,
  jobId: string
): Promise<void> {
  try {
    await cleanupJobRuntimeTree(dataDir, threadId, jobId)
  } catch {
    // best-effort filesystem purge
  }
}

/** Strict variant for deletion coordinator — surfaces filesystem errors instead of swallowing. */
export async function purgeJobFilesystemStrict(
  dataDir: string,
  threadId: string,
  jobId: string
): Promise<void> {
  await cleanupJobRuntimeTree(dataDir, threadId, jobId, { deletionDrained: true })
}

export async function purgeThreadFilesystem(
  dataDir: string,
  threadId: string,
  targets: ThreadPurgeTargets
): Promise<void> {
  await cleanupThreadRuntimeTree(dataDir, threadId).catch(() => {})
  try {
    await processPendingAssetDeletes(dataDir, getDb())
  } catch {
    // The non-strict helper also runs against isolated fixtures without a global DB.
  }
  await removeFrozenAttachmentTargets(dataDir, threadId, targets).catch(() => {})
  await removeThreadAttachmentsDirIfEmpty(dataDir, threadId).catch(() => {})

  await Promise.all(
    targets.messageIds.map((messageId) => deleteMessageArtifactFiles(dataDir, messageId))
  )
}

/** Strict variant for deletion coordinator — surfaces filesystem errors instead of swallowing. */
export async function purgeThreadFilesystemStrict(
  dataDir: string,
  threadId: string,
  targets: ThreadPurgeTargets
): Promise<void> {
  await cleanupThreadRuntimeTree(dataDir, threadId, { deletionDrained: true })
  await processPendingAssetDeletes(dataDir, getDb())
  await removeFrozenAttachmentTargets(dataDir, threadId, targets)
  await removeThreadAttachmentsDirIfEmpty(dataDir, threadId)
  await Promise.all(
    targets.messageIds.map((messageId) => deleteMessageArtifactFiles(dataDir, messageId))
  )
}
