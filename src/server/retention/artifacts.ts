import { createHash, randomUUID } from 'crypto'
import { gunzipSync, gzipSync } from 'zlib'
import { existsSync, readFileSync } from 'fs'
import { mkdir, readFile, rename, rm, unlink, writeFile } from 'fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'path'
import { and, eq, inArray, lte } from 'drizzle-orm'
import type {
  JobArtifactKind,
  JobArtifactTier,
  RetentionSettings
} from '../../shared/contracts/retention.ts'
import type { getDb } from '../db'
import { jobArtifacts } from '../db/schema'
import { jobArtifactRelPath } from '../data-paths'
import { signalArtifactExpiry } from './expiry-signal'

type AppDatabase = ReturnType<typeof getDb>

/** Metadata columns only — never pull content bytes for list/cleanup paths. */
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

function safeArtifactPath(dataDir: string, contentPath: string): string | null {
  if (isAbsolute(contentPath)) return null
  const root = resolve(dataDir)
  const target = resolve(root, contentPath)
  const rel = relative(root, target)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return target
}

async function removeArtifactFile(dataDir: string, contentPath: string | null): Promise<void> {
  if (!contentPath) return
  const path = safeArtifactPath(dataDir, contentPath)
  if (!path) return
  await unlink(path).catch(() => {})
}

async function removeArtifactFileIfUnreferenced(
  db: AppDatabase,
  dataDir: string,
  contentPath: string | null
): Promise<void> {
  if (!contentPath) return
  const remaining = await db
    .select({ id: jobArtifacts.id })
    .from(jobArtifacts)
    .where(eq(jobArtifacts.contentPath, contentPath))
    .limit(1)
  if (remaining.length === 0) await removeArtifactFile(dataDir, contentPath)
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
  const inlineMaxBytes = Math.max(0, input.settings?.artifactInlineMaxBytes ?? 8192)
  const inline = byteSize <= inlineMaxBytes
  const contentPath = inline ? null : jobArtifactRelPath(contentHash)
  let stagingPath: string | null = null
  let finalPath: string | null = null
  let finalCreated = false

  const previous =
    input.taskId && input.replaceExisting !== false
      ? await input.db
          .select(jobArtifactMeta)
          .from(jobArtifacts)
          .where(
            and(
              eq(jobArtifacts.jobId, input.jobId),
              eq(jobArtifacts.taskId, input.taskId),
              eq(jobArtifacts.kind, input.kind)
            )
          )
      : []

  if (!inline && contentPath) {
    finalPath = safeArtifactPath(input.dataDir, contentPath)
    if (!finalPath) throw new Error('Invalid Job Artifact path')
    stagingPath = `${finalPath}.staging-${id}`
    try {
      await mkdir(dirname(finalPath), { recursive: true })
      await writeFile(stagingPath, compressed)
      if (existsSync(finalPath)) {
        await rm(stagingPath, { force: true })
      } else {
        await rename(stagingPath, finalPath)
        finalCreated = true
      }
    } catch (error) {
      await rm(stagingPath, { force: true }).catch(() => {})
      throw error
    }
  }

  try {
    input.db.transaction((tx) => {
      if (previous.length > 0) {
        tx.delete(jobArtifacts)
          .where(
            inArray(
              jobArtifacts.id,
              previous.map((row) => row.id)
            )
          )
          .run()
      }
      tx.insert(jobArtifacts)
        .values({
          id,
          jobId: input.jobId,
          taskId: input.taskId ?? null,
          kind: input.kind,
          tier,
          contentHash,
          byteSize,
          storage: inline ? 'inline' : 'file',
          contentInline: null,
          contentBlob: inline ? compressed : null,
          contentPath,
          createdAt,
          expiresAt
        })
        .run()
    })
  } catch (error) {
    if (stagingPath) await rm(stagingPath, { force: true }).catch(() => {})
    if (finalCreated) {
      await removeArtifactFileIfUnreferenced(input.db, input.dataDir, contentPath).catch(() => {})
    }
    throw error
  }

  for (const path of new Set(previous.map((row) => row.contentPath))) {
    await removeArtifactFileIfUnreferenced(input.db, input.dataDir, path).catch((error) => {
      console.warn('[retention] failed to remove superseded Job Artifact file', error)
    })
  }
  signalArtifactExpiry(expiresAt)
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
  await removeArtifactFileIfUnreferenced(input.db, input.dataDir, row.contentPath)
  return true
}

function parsePayload<T>(compressed: Buffer, expectedHash: string): T | null {
  try {
    const raw = gunzipSync(compressed).toString('utf8')
    if (hashContent(raw) !== expectedHash) return null
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export async function getJobArtifactPayload<T = unknown>(
  db: AppDatabase,
  dataDir: string,
  artifactId: string
): Promise<T | null> {
  const rows = await db.select().from(jobArtifacts).where(eq(jobArtifacts.id, artifactId)).limit(1)
  const row = rows[0]
  if (!row || (row.expiresAt != null && row.expiresAt <= nowSec())) return null

  if (row.storage === 'inline' && row.contentBlob) {
    return parsePayload<T>(row.contentBlob, row.contentHash)
  }
  if (row.storage === 'file' && row.contentPath) {
    const path = safeArtifactPath(dataDir, row.contentPath)
    if (!path) return null
    const compressed = await readFile(path).catch(() => null)
    return compressed ? parsePayload<T>(compressed, row.contentHash) : null
  }
  return null
}

/** Synchronous reader for call sites that hydrate state during DB mapping. */
export function getJobArtifactPayloadSync<T = unknown>(
  db: AppDatabase,
  dataDir: string,
  artifactId: string
): T | null {
  const row = db
    .select()
    .from(jobArtifacts)
    .where(eq(jobArtifacts.id, artifactId))
    .limit(1)
    .all()[0]
  if (!row || (row.expiresAt != null && row.expiresAt <= nowSec())) return null

  if (row.storage === 'inline' && row.contentBlob) {
    return parsePayload<T>(row.contentBlob, row.contentHash)
  }
  if (row.storage === 'file' && row.contentPath) {
    const path = safeArtifactPath(dataDir, row.contentPath)
    if (!path) return null
    try {
      return parsePayload<T>(readFileSync(path), row.contentHash)
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
  signalArtifactExpiry(expiresAt)
}

export async function deleteExpiredArtifacts(
  db: AppDatabase,
  dataDir: string,
  cutoff = nowSec()
): Promise<{ deleted: number; deletedBytes: number }> {
  const expired = await db
    .select(jobArtifactMeta)
    .from(jobArtifacts)
    .where(lte(jobArtifacts.expiresAt, cutoff))
    .limit(250)

  if (expired.length > 0) {
    await db.delete(jobArtifacts).where(
      inArray(
        jobArtifacts.id,
        expired.map((row) => row.id)
      )
    )
    await Promise.all(
      [
        ...new Set(
          expired.map((row) => row.contentPath).filter((path): path is string => Boolean(path))
        )
      ].map((path) => removeArtifactFileIfUnreferenced(db, dataDir, path))
    )
  }

  return {
    deleted: expired.length,
    deletedBytes: expired.reduce((total, row) => total + row.byteSize, 0)
  }
}
