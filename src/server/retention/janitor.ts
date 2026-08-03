import { existsSync } from 'fs'
import { readdir, rm } from 'fs/promises'
import { join } from 'path'
import { eq } from 'drizzle-orm'
import { parseJobReferenceManifest } from '../../shared/job-references.ts'
import type { getDb } from '../db'
import { jobArtifacts, messageArtifacts, threadMessages, threads } from '../db/schema'
import { dataPaths, threadAttachmentsDir } from '../data-paths'
import { wipeLegacyRuntimesRoot } from '../runtime/cleanup'

type AppDatabase = ReturnType<typeof getDb>

function sqliteClient(db: AppDatabase): import('better-sqlite3').Database | null {
  return (db as AppDatabase & { $client?: import('better-sqlite3').Database }).$client ?? null
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

/** Collect Design + Execution attachment ids for a thread's project (no thread_jobs). */
function collectProjectScopedAttachmentIds(
  db: AppDatabase,
  threadId: string
): string[] {
  const client = sqliteClient(db)
  if (!client) return []
  const ids: string[] = []
  try {
    const designRows = client
      .prepare(
        `SELECT dr.attachment_id AS attachmentId
         FROM design_draft_references dr
         JOIN drafts d ON d.id = dr.draft_id
         JOIN threads t ON t.project_id = d.project_id
         WHERE t.id = ? AND dr.attachment_id IS NOT NULL`
      )
      .all(threadId) as Array<{ attachmentId: string }>
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
         JOIN threads t ON t.project_id = j.project_id
         WHERE t.id = ?`
      )
      .all(threadId) as Array<{ referenceManifestJson: string }>
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

  const threadRows = await db.select({ id: threads.id }).from(threads)
  let removed = 0

  for (const thread of threadRows) {
    const threadDir = join(attachmentsRoot, thread.id)
    if (!existsSync(threadDir)) continue

    const messageRows = await db
      .select({ attachmentsJson: threadMessages.attachmentsJson })
      .from(threadMessages)
      .where(eq(threadMessages.threadId, thread.id))

    const validAttachmentIds = new Set<string>(collectProjectScopedAttachmentIds(db, thread.id))
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
