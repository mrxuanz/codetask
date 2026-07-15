import { eq } from 'drizzle-orm'
import type { getDb } from '../db'
import { threadMessages } from '../db/schema'
import { deleteMessageArtifactFiles } from './message-artifacts'
import { removeThreadAttachmentsDir } from './janitor'
import { cleanupJobRuntimeTree, cleanupThreadRuntimeTree } from '../runtime/cleanup'

type AppDatabase = ReturnType<typeof getDb>

export interface ThreadPurgeTargets {
  messageIds: string[]
}

export async function collectThreadPurgeTargets(
  db: AppDatabase,
  threadId: string
): Promise<ThreadPurgeTargets> {
  const messageRows = await db
    .select({ id: threadMessages.id })
    .from(threadMessages)
    .where(eq(threadMessages.threadId, threadId))

  return {
    messageIds: messageRows.map((row) => row.id)
  }
}

export async function purgeJobFilesystem(
  dataDir: string,
  threadId: string,
  jobId: string
): Promise<void> {
  await cleanupJobRuntimeTree(dataDir, threadId, jobId).catch(() => {})
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
