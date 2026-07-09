import { eq } from 'drizzle-orm'
import type { getDb } from '../db'
import { threadJobs, threadMessages } from '../db/schema'
import { designArtifactDir } from '../data-paths'
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
  const [jobRows, messageRows] = await Promise.all([
    db.select({ id: threadJobs.id }).from(threadJobs).where(eq(threadJobs.threadId, threadId)),
    db
      .select({ id: threadMessages.id })
      .from(threadMessages)
      .where(eq(threadMessages.threadId, threadId))
  ])

  return {
    designSessionIds: jobRows.map((row) => row.id),
    messageIds: messageRows.map((row) => row.id)
  }
}

export async function deleteDesignArtifactFiles(
  dataDir: string,
  designSessionId: string
): Promise<void> {
  const { rm } = await import('fs/promises')
  await rm(designArtifactDir(dataDir, designSessionId), {
    recursive: true,
    force: true
  }).catch(() => {})
}

export async function purgeJobFilesystem(
  dataDir: string,
  threadId: string,
  jobId: string
): Promise<void> {
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
