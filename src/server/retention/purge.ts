import type { getDb } from '../db'
import { deleteMessageArtifactFiles } from './message-artifacts'
import { removeThreadAttachmentsDir } from './janitor'
import { cleanupJobRuntimeTree, cleanupThreadRuntimeTree } from '../runtime/cleanup'

type AppDatabase = ReturnType<typeof getDb>

function sqliteClient(db: AppDatabase): import('better-sqlite3').Database | null {
  return (db as AppDatabase & { $client?: import('better-sqlite3').Database }).$client ?? null
}

export interface ThreadPurgeTargets {
  messageIds: string[]
}

export async function collectThreadPurgeTargets(
  db: AppDatabase,
  conversationId: string
): Promise<ThreadPurgeTargets> {
  const client = sqliteClient(db)
  if (!client) return { messageIds: [] }
  try {
    const messageRows = client
      .prepare(`SELECT id FROM conversation_messages WHERE conversation_id = ?`)
      .all(conversationId) as Array<{ id: string }>
    return { messageIds: messageRows.map((row) => row.id) }
  } catch {
    return { messageIds: [] }
  }
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
  await removeThreadAttachmentsDir(dataDir, threadId).catch(() => {})

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
  await removeThreadAttachmentsDir(dataDir, threadId)
  await Promise.all(
    targets.messageIds.map((messageId) => deleteMessageArtifactFiles(dataDir, messageId))
  )
}
