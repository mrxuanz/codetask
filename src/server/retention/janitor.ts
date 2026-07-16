import { existsSync } from 'fs'
import { readdir, rm } from 'fs/promises'
import { join } from 'path'
import { eq, or } from 'drizzle-orm'
import { parseJobReferenceManifest } from '@shared/job-references'
import type { getDb } from '../db'
import {
  draftReferences,
  jobArtifacts,
  jobTasks,
  messageArtifacts,
  threadJobs,
  threadMessages,
  threads
} from '../db/schema'
import { dataPaths, threadAttachmentsDir } from '../data-paths'
import { cleanupJobTaskRuntimeTree } from '../runtime/cleanup'

type AppDatabase = ReturnType<typeof getDb>

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
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

export async function pruneOrphanAttachments(
  dataDir: string,
  db: AppDatabase
): Promise<{ removed: number }> {
  const root = dataPaths(dataDir).attachments
  if (!existsSync(root)) return { removed: 0 }

  const threadRows = await db.select({ id: threads.id }).from(threads)
  const valid = new Set(threadRows.map((row) => row.id))
  let removed = 0

  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (valid.has(entry.name)) continue
    await rm(join(root, entry.name), { recursive: true, force: true })
    removed += 1
  }

  return { removed }
}

export async function pruneStalePausedRuntimeTrees(
  dataDir: string,
  db: AppDatabase,
  pausedDays: number
): Promise<{ removed: number }> {
  if (pausedDays <= 0) return { removed: 0 }

  const cutoff = nowSec() - pausedDays * 86_400
  const rows = await db
    .select({ id: threadJobs.id, threadId: threadJobs.threadId, updatedAt: threadJobs.updatedAt })
    .from(threadJobs)
    .where(or(eq(threadJobs.status, 'paused'), eq(threadJobs.status, 'pausing')))

  let removed = 0
  for (const row of rows) {
    if (row.updatedAt >= cutoff) continue
    const jobPath = join(dataPaths(dataDir).runtimes, row.threadId, 'jobs', row.id)
    if (!existsSync(jobPath)) continue
    await rm(jobPath, { recursive: true, force: true })
    removed += 1
  }

  return { removed }
}

export async function pruneCompletedTaskRuntimeTrees(
  dataDir: string,
  db: AppDatabase
): Promise<{ removed: number }> {
  const rows = await db
    .select({
      jobId: jobTasks.jobId,
      taskId: jobTasks.taskId,
      threadId: threadJobs.threadId
    })
    .from(jobTasks)
    .innerJoin(threadJobs, eq(jobTasks.jobId, threadJobs.id))
    .where(eq(jobTasks.status, 'completed'))

  let removed = 0
  for (const row of rows) {
    if (await cleanupJobTaskRuntimeTree(dataDir, row.threadId, row.jobId, row.taskId)) {
      removed += 1
    }
  }
  return { removed }
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

function parseMessageAttachmentIds(attachmentsJson: string | null): string[] {
  if (!attachmentsJson) return []
  try {
    const parsed = JSON.parse(attachmentsJson) as Array<{ id?: string }>
    if (!Array.isArray(parsed)) return []
    return parsed.map((item) => item.id).filter((id): id is string => typeof id === 'string')
  } catch {
    return []
  }
}

export async function pruneStaleThreadAttachmentDirs(
  dataDir: string,
  db: AppDatabase
): Promise<{ removed: number }> {
  const attachmentsRoot = dataPaths(dataDir).attachments
  if (!existsSync(attachmentsRoot)) return { removed: 0 }

  const threadRows = await db.select({ id: threads.id }).from(threads)
  let removed = 0

  for (const thread of threadRows) {
    const threadDir = join(attachmentsRoot, thread.id)
    if (!existsSync(threadDir)) continue

    const [referenceRows, messageRows, jobRows] = await Promise.all([
      db
        .select({ attachmentId: draftReferences.attachmentId })
        .from(draftReferences)
        .innerJoin(threadJobs, eq(draftReferences.designSessionId, threadJobs.id))
        .where(eq(threadJobs.threadId, thread.id)),
      db
        .select({ attachmentsJson: threadMessages.attachmentsJson })
        .from(threadMessages)
        .where(eq(threadMessages.threadId, thread.id)),
      db
        .select({ referenceManifestJson: threadJobs.referenceManifestJson })
        .from(threadJobs)
        .where(eq(threadJobs.threadId, thread.id))
    ])

    const validAttachmentIds = new Set<string>()
    for (const row of referenceRows) {
      if (row.attachmentId) validAttachmentIds.add(row.attachmentId)
    }
    for (const row of messageRows) {
      for (const attachmentId of parseMessageAttachmentIds(row.attachmentsJson)) {
        validAttachmentIds.add(attachmentId)
      }
    }
    for (const row of jobRows) {
      const manifest = parseJobReferenceManifest(row.referenceManifestJson)
      for (const reference of manifest?.references ?? []) {
        if (reference.storageOwner === 'job' && reference.attachmentId) {
          validAttachmentIds.add(reference.attachmentId)
        }
      }
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
