import { join } from 'path'
import { eq } from 'drizzle-orm'
import type { getDb } from '../db'
import { designSessions, threadMessages } from '../db/schema'
import { deleteJobArtifactFiles } from './artifacts'
import { deleteMessageArtifactFiles } from './message-artifacts'
import { removeThreadAttachmentsDir } from './janitor'
import { cleanupJobRuntimeTree, cleanupThreadRuntimeTree } from '../runtime/cleanup'

type AppDatabase = ReturnType<typeof getDb>

export interface ThreadPurgeTargets {
  designSessionIds: string[]
  messageIds: string[]
}

export async function collectThreadPurgeTargets(
  db: AppDatabase,
  threadId: string
): Promise<ThreadPurgeTargets> {
  const [sessionRows, messageRows] = await Promise.all([
    db
      .select({ id: designSessions.id })
      .from(designSessions)
      .where(eq(designSessions.threadId, threadId)),
    db
      .select({ id: threadMessages.id })
      .from(threadMessages)
      .where(eq(threadMessages.threadId, threadId))
  ])

  return {
    designSessionIds: sessionRows.map((row) => row.id),
    messageIds: messageRows.map((row) => row.id)
  }
}

export async function deleteDesignArtifactFiles(
  dataDir: string,
  designSessionId: string
): Promise<void> {
  const { rm } = await import('fs/promises')
  await rm(join(dataDir, 'artifacts', 'designs', designSessionId), {
    recursive: true,
    force: true
  }).catch(() => {})
}

export async function purgeJobFilesystem(
  dataDir: string,
  threadId: string,
  jobId: string
): Promise<void> {
  await deleteJobArtifactFiles(dataDir, jobId)
  await cleanupJobRuntimeTree(dataDir, threadId, jobId).catch(() => {})
}

export async function purgeThreadFilesystem(
  dataDir: string,
  threadId: string,
  targets: ThreadPurgeTargets
): Promise<void> {
  await cleanupThreadRuntimeTree(dataDir, threadId).catch(() => {})
  await removeThreadAttachmentsDir(dataDir, threadId).catch(() => {})

  await Promise.all([
    ...targets.designSessionIds.map((designSessionId) =>
      deleteDesignArtifactFiles(dataDir, designSessionId)
    ),
    ...targets.messageIds.map((messageId) => deleteMessageArtifactFiles(dataDir, messageId))
  ])
}
