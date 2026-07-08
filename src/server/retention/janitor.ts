import { existsSync } from 'fs'
import { readdir, rm } from 'fs/promises'
import { join } from 'path'
import { eq, or } from 'drizzle-orm'
import type { getDb } from '../db'
import {
  designSessions,
  draftReferences,
  jobArtifacts,
  messageArtifacts,
  threadJobs,
  threadMessages,
  threads
} from '../db/schema'

type AppDatabase = ReturnType<typeof getDb>

const RESERVED_ARTIFACT_DIRS = new Set(['messages', 'designs'])

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

export async function removeThreadAttachmentsDir(
  dataDir: string,
  threadId: string
): Promise<boolean> {
  const path = join(dataDir, 'attachments', threadId)
  if (!existsSync(path)) return false
  await rm(path, { recursive: true, force: true })
  return true
}

export async function pruneOrphanAttachments(
  dataDir: string,
  db: AppDatabase
): Promise<{ removed: number }> {
  const root = join(dataDir, 'attachments')
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
    const jobPath = join(dataDir, 'runtimes', row.threadId, 'jobs', row.id)
    if (!existsSync(jobPath)) continue
    await rm(jobPath, { recursive: true, force: true })
    removed += 1
  }

  return { removed }
}

export async function pruneLegacyEvidenceFiles(dataDir: string): Promise<{ removed: number }> {
  const legacyRoot = join(dataDir, 'jobs')
  if (!existsSync(legacyRoot)) return { removed: 0 }
  let removed = 0
  for (const jobEntry of await readdir(legacyRoot, { withFileTypes: true })) {
    if (!jobEntry.isDirectory()) continue
    const evidenceDir = join(legacyRoot, jobEntry.name, 'evidence')
    if (!existsSync(evidenceDir)) continue
    await rm(evidenceDir, { recursive: true, force: true })
    removed += 1
  }
  return { removed }
}

export async function pruneOrphanMessageArtifactDirs(
  dataDir: string,
  db: AppDatabase
): Promise<{ removed: number }> {
  const root = join(dataDir, 'artifacts', 'messages')
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

export async function pruneOrphanJobArtifactDirs(
  dataDir: string,
  db: AppDatabase
): Promise<{ removed: number }> {
  const root = join(dataDir, 'artifacts')
  if (!existsSync(root)) return { removed: 0 }

  const [jobRows, artifactRows] = await Promise.all([
    db.select({ id: threadJobs.id }).from(threadJobs),
    db
      .select({ jobId: jobArtifacts.jobId, contentPath: jobArtifacts.contentPath })
      .from(jobArtifacts)
      .where(eq(jobArtifacts.storage, 'file'))
  ])

  const validJobIds = new Set(jobRows.map((row) => row.id))
  const referencedPaths = new Set(
    artifactRows
      .map((row) => row.contentPath?.replace(/\\/g, '/'))
      .filter((path): path is string => Boolean(path))
  )

  let removed = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (RESERVED_ARTIFACT_DIRS.has(entry.name)) continue
    if (validJobIds.has(entry.name)) continue

    const dirPath = join(root, entry.name)
    const hasReferencedFile = [...referencedPaths].some((path) =>
      path.startsWith(`artifacts/${entry.name}/`)
    )
    if (hasReferencedFile) continue

    await rm(dirPath, { recursive: true, force: true })
    removed += 1
  }

  return { removed }
}

export async function pruneOrphanDesignArtifactDirs(
  dataDir: string,
  db: AppDatabase
): Promise<{ removed: number }> {
  const root = join(dataDir, 'artifacts', 'designs')
  if (!existsSync(root)) return { removed: 0 }

  const rows = await db.select({ id: designSessions.id }).from(designSessions)
  const valid = new Set(rows.map((row) => row.id))
  let removed = 0

  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (valid.has(entry.name)) continue
    await rm(join(root, entry.name), { recursive: true, force: true })
    removed += 1
  }

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
  const attachmentsRoot = join(dataDir, 'attachments')
  if (!existsSync(attachmentsRoot)) return { removed: 0 }

  const threadRows = await db.select({ id: threads.id }).from(threads)
  let removed = 0

  for (const thread of threadRows) {
    const threadDir = join(attachmentsRoot, thread.id)
    if (!existsSync(threadDir)) continue

    const [referenceRows, messageRows] = await Promise.all([
      db
        .select({ attachmentId: draftReferences.attachmentId })
        .from(draftReferences)
        .innerJoin(designSessions, eq(draftReferences.designSessionId, designSessions.id))
        .where(eq(designSessions.threadId, thread.id)),
      db
        .select({ attachmentsJson: threadMessages.attachmentsJson })
        .from(threadMessages)
        .where(eq(threadMessages.threadId, thread.id))
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

    for (const entry of await readdir(threadDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (validAttachmentIds.has(entry.name)) continue
      await rm(join(threadDir, entry.name), { recursive: true, force: true })
      removed += 1
    }
  }

  return { removed }
}
