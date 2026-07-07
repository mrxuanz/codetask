import { createHash, randomUUID } from 'crypto'
import { gunzipSync, gzipSync } from 'zlib'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { and, eq, lt } from 'drizzle-orm'
import type { JobArtifactKind, JobArtifactTier } from '../../shared/contracts/retention.ts'
import { DEFAULT_RETENTION_SETTINGS } from '../../shared/contracts/retention.ts'
import type { RetentionSettings } from '../../shared/contracts/retention.ts'
import type { getDb } from '../db'
import { jobArtifacts } from '../db/schema'

type AppDatabase = ReturnType<typeof getDb>

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function hashContent(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

export function artifactFileRelPath(jobId: string, artifactId: string): string {
  return join('artifacts', jobId, `${artifactId}.json.gz`)
}

export function artifactFileAbsPath(dataDir: string, jobId: string, artifactId: string): string {
  return join(dataDir, artifactFileRelPath(jobId, artifactId))
}

export async function deleteArtifactFile(
  dataDir: string,
  jobId: string,
  artifactId: string
): Promise<void> {
  await rm(artifactFileAbsPath(dataDir, jobId, artifactId), { force: true })
}

async function writeArtifactFile(
  dataDir: string,
  jobId: string,
  artifactId: string,
  raw: string
): Promise<void> {
  const abs = artifactFileAbsPath(dataDir, jobId, artifactId)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, gzipSync(raw))
}

async function readArtifactFile(dataDir: string, relPath: string): Promise<string | null> {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (normalized.includes('..')) return null
  try {
    const buf = await readFile(join(dataDir, normalized))
    return gunzipSync(buf).toString('utf8')
  } catch {
    return null
  }
}

export async function putJobArtifact(input: {
  db: AppDatabase
  dataDir: string
  jobId: string
  taskId?: string | null
  kind: JobArtifactKind
  tier?: JobArtifactTier
  payload: unknown
  expiresAt?: number | null
  settings?: RetentionSettings
  replaceExisting?: boolean
}): Promise<string> {
  const settings = input.settings ?? DEFAULT_RETENTION_SETTINGS
  const tier = input.tier ?? 'working'
  const expiresAt = input.expiresAt ?? null

  const raw = JSON.stringify(input.payload)
  const byteSize = Buffer.byteLength(raw, 'utf8')
  const contentHash = hashContent(raw)
  const id = `art-${randomUUID()}`
  const createdAt = nowSec()

  let storage: 'inline' | 'file' = 'inline'
  let contentInline: string | null = raw
  let contentPath: string | null = null

  if (byteSize > settings.artifactInlineMaxBytes) {
    storage = 'file'
    contentInline = null
    contentPath = artifactFileRelPath(input.jobId, id)
    await writeArtifactFile(input.dataDir, input.jobId, id, raw)
  }

  if (input.taskId && input.replaceExisting !== false) {
    const existing = await input.db
      .select()
      .from(jobArtifacts)
      .where(
        and(
          eq(jobArtifacts.jobId, input.jobId),
          eq(jobArtifacts.taskId, input.taskId),
          eq(jobArtifacts.kind, input.kind)
        )
      )
    for (const row of existing) {
      if (row.storage === 'file' && row.contentPath) {
        await rm(join(input.dataDir, row.contentPath.replace(/\\/g, '/')), { force: true }).catch(
          () => {}
        )
      }
    }
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
    contentPath,
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
    .select()
    .from(jobArtifacts)
    .where(eq(jobArtifacts.id, input.artifactId))
    .limit(1)
  const row = rows[0]
  if (!row) return false

  if (row.storage === 'file' && row.contentPath) {
    await rm(join(input.dataDir, row.contentPath.replace(/\\/g, '/')), { force: true }).catch(
      () => {}
    )
  }

  await input.db.delete(jobArtifacts).where(eq(jobArtifacts.id, input.artifactId))
  return true
}

export async function getJobArtifactPayload<T = unknown>(
  db: AppDatabase,
  dataDir: string,
  artifactId: string
): Promise<T | null> {
  const rows = await db.select().from(jobArtifacts).where(eq(jobArtifacts.id, artifactId)).limit(1)
  const row = rows[0]
  if (!row) return null

  if (row.expiresAt != null && row.expiresAt < nowSec()) {
    return null
  }

  if (row.storage === 'inline' && row.contentInline) {
    try {
      return JSON.parse(row.contentInline) as T
    } catch {
      return null
    }
  }

  if (row.storage === 'file' && row.contentPath) {
    const raw = await readArtifactFile(dataDir, row.contentPath)
    if (!raw) return null
    try {
      return JSON.parse(raw) as T
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
  dataDir: string
): Promise<{ deleted: number }> {
  const cutoff = nowSec()
  const expired = await db.select().from(jobArtifacts).where(lt(jobArtifacts.expiresAt, cutoff))

  for (const row of expired) {
    if (row.storage === 'file' && row.contentPath) {
      await rm(join(dataDir, row.contentPath.replace(/\\/g, '/')), { force: true }).catch(() => {})
    }
  }

  if (expired.length > 0) {
    await db.delete(jobArtifacts).where(lt(jobArtifacts.expiresAt, cutoff))
  }

  return { deleted: expired.length }
}

export async function deleteJobArtifactFiles(dataDir: string, jobId: string): Promise<void> {
  await rm(join(dataDir, 'artifacts', jobId), { recursive: true, force: true }).catch(() => {})
}

export function isLegacyEvidenceRef(ref: string): boolean {
  return ref.startsWith('jobs/') && ref.includes('/evidence/')
}

export async function readLegacyEvidenceFile(
  dataDir: string,
  evidenceRef: string
): Promise<unknown | null> {
  const rel = evidenceRef.replace(/\\/g, '/').replace(/^\/+/, '')
  if (rel.includes('..')) return null
  try {
    const raw = await readFile(join(dataDir, rel), 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}
