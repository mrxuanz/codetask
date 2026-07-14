import { createHash, randomUUID } from 'crypto'
import { gunzipSync, gzipSync } from 'zlib'
import { and, eq, lt } from 'drizzle-orm'
import type { JobArtifactKind, JobArtifactTier, RetentionSettings } from '../../shared/contracts/retention.ts'
import type { getDb } from '../db'
import { jobArtifacts } from '../db/schema'

type AppDatabase = ReturnType<typeof getDb>

/** Metadata columns only — never pull contentInline/blob for list/cleanup paths. */
const jobArtifactMeta = {
  id: jobArtifacts.id,
  jobId: jobArtifacts.jobId,
  taskId: jobArtifacts.taskId,
  kind: jobArtifacts.kind,
  tier: jobArtifacts.tier,
  contentHash: jobArtifacts.contentHash,
  byteSize: jobArtifacts.byteSize,
  storage: jobArtifacts.storage,
  contentPath: jobArtifacts.contentPath,
  createdAt: jobArtifacts.createdAt,
  expiresAt: jobArtifacts.expiresAt
} as const

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function hashContent(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

export async function putJobArtifact(input: {
  db: AppDatabase
  dataDir: string
  jobId: string
  taskId?: string | null | undefined
  kind: JobArtifactKind
  tier?: JobArtifactTier | undefined
  payload: unknown
  expiresAt?: number | null | undefined
  settings?: RetentionSettings | undefined
  replaceExisting?: boolean | undefined
}): Promise<string> {
  const tier = input.tier ?? 'working'
  const expiresAt = input.expiresAt ?? null

  const raw = JSON.stringify(input.payload)
  const byteSize = Buffer.byteLength(raw, 'utf8')
  const contentHash = hashContent(raw)
  const id = `art-${randomUUID()}`
  const createdAt = nowSec()

  const compressed = gzipSync(raw)
  const contentInline = compressed.toString('base64')
  const storage = 'inline' as const

  if (input.taskId && input.replaceExisting !== false) {
    await input.db
      .delete(jobArtifacts)
      .where(
        and(
          eq(jobArtifacts.jobId, input.jobId),
          eq(jobArtifacts.taskId, input.taskId),
          eq(jobArtifacts.kind, input.kind)
        )
      )
  }

  await input.db.insert(jobArtifacts).values({
    id,
    jobId: input.jobId,
    taskId: input.taskId ?? null,
    kind: input.kind,
    tier,
    contentHash,
    byteSize,
    storage,
    contentInline,
    contentPath: null,
    createdAt,
    expiresAt: expiresAt ?? null
  })

  return id
}

export async function deleteJobArtifact(input: {
  db: AppDatabase
  dataDir: string
  artifactId: string
}): Promise<boolean> {
  const rows = await input.db
    .select(jobArtifactMeta)
    .from(jobArtifacts)
    .where(eq(jobArtifacts.id, input.artifactId))
    .limit(1)
  const row = rows[0]
  if (!row) return false

  await input.db.delete(jobArtifacts).where(eq(jobArtifacts.id, input.artifactId))
  return true
}

function decompressInline(encoded: string): string | null {
  try {
    const buf = Buffer.from(encoded, 'base64')
    return gunzipSync(buf).toString('utf8')
  } catch {
    return null
  }
}

export async function getJobArtifactPayload<T = unknown>(
  db: AppDatabase,
  _dataDir: string,
  artifactId: string
): Promise<T | null> {
  const rows = await db.select().from(jobArtifacts).where(eq(jobArtifacts.id, artifactId)).limit(1)
  const row = rows[0]
  if (!row) return null

  if (row.expiresAt != null && row.expiresAt < nowSec()) {
    return null
  }

  if (row.storage === 'inline' && row.contentInline) {
    const decompressed = decompressInline(row.contentInline)
    if (decompressed) {
      try {
        return JSON.parse(decompressed) as T
      } catch {
        return null
      }
    }
    try {
      return JSON.parse(row.contentInline) as T
    } catch {
      return null
    }
  }

  return null
}

export async function scheduleJobArtifactExpiry(
  db: AppDatabase,
  jobId: string,
  expiresAt: number | null
): Promise<void> {
  await db.update(jobArtifacts).set({ expiresAt }).where(eq(jobArtifacts.jobId, jobId))
}

export async function deleteExpiredArtifacts(
  db: AppDatabase,
  _dataDir: string
): Promise<{ deleted: number }> {
  const cutoff = nowSec()
  const expired = await db
    .select(jobArtifactMeta)
    .from(jobArtifacts)
    .where(lt(jobArtifacts.expiresAt, cutoff))

  if (expired.length > 0) {
    await db.delete(jobArtifacts).where(lt(jobArtifacts.expiresAt, cutoff))
  }

  return { deleted: expired.length }
}
