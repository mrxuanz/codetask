import { createHash, randomUUID } from 'crypto'
import { gunzipSync, gzipSync } from 'zlib'
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { and, eq, inArray, lte } from 'drizzle-orm'
import { DEFAULT_RETENTION_SETTINGS } from '../../shared/contracts/retention.ts'
import type { RetentionSettings } from '../../shared/contracts/retention.ts'
import { messageArtifactDir, messageArtifactRelPath } from '../data-paths'
import type { getDb } from '../db'
import { messageArtifacts } from '../db/schema'
import { signalArtifactExpiry } from './expiry-signal'

type AppDatabase = ReturnType<typeof getDb>

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function hashContent(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

/** @deprecated Prefer messageArtifactRelPath from data-paths; kept as re-export for callers. */
export function messageArtifactFileRelPath(messageId: string, artifactId: string): string {
  return messageArtifactRelPath(messageId, artifactId)
}

function messageArtifactFileAbsPath(
  dataDir: string,
  messageId: string,
  artifactId: string
): string {
  return join(dataDir, messageArtifactRelPath(messageId, artifactId))
}

async function stageMessageArtifactFile(
  dataDir: string,
  messageId: string,
  artifactId: string,
  raw: string
): Promise<{ staging: string; final: string }> {
  const abs = messageArtifactFileAbsPath(dataDir, messageId, artifactId)
  await mkdir(dirname(abs), { recursive: true })
  const staging = `${abs}.staging-${randomUUID()}`
  await writeFile(staging, gzipSync(raw))
  return { staging, final: abs }
}

function safeMessageArtifactPath(dataDir: string, relPath: string): string | null {
  if (isAbsolute(relPath)) return null
  const root = resolve(dataDir)
  const target = resolve(root, relPath)
  const rel = relative(root, target)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return target
}

async function readMessageArtifactFile(dataDir: string, relPath: string): Promise<string | null> {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (normalized.includes('..')) return null
  try {
    const buf = await readFile(join(dataDir, normalized))
    return gunzipSync(buf).toString('utf8')
  } catch {
    return null
  }
}

export async function putMessageArtifact(input: {
  db: AppDatabase
  dataDir: string
  messageId: string
  kind?: string
  payload: unknown
  expiresAt?: number | null
  settings?: RetentionSettings
}): Promise<string> {
  const settings = input.settings ?? DEFAULT_RETENTION_SETTINGS
  const kind = input.kind ?? 'payload'
  const inlineMax = settings.messagePayloadInlineMaxBytes
  const raw = JSON.stringify(input.payload)
  const byteSize = Buffer.byteLength(raw, 'utf8')
  const contentHash = hashContent(raw)
  const id = `msg-art-${randomUUID()}`
  const createdAt = nowSec()

  let storage: 'inline' | 'file' = 'inline'
  let contentInline: string | null = raw
  let contentPath: string | null = null

  let staged: { staging: string; final: string } | null = null
  if (byteSize > inlineMax) {
    storage = 'file'
    contentInline = null
    contentPath = messageArtifactRelPath(input.messageId, id)
    staged = await stageMessageArtifactFile(input.dataDir, input.messageId, id, raw)
  }

  const existing = await input.db
    .select()
    .from(messageArtifacts)
    .where(and(eq(messageArtifacts.messageId, input.messageId), eq(messageArtifacts.kind, kind)))

  if (staged) {
    try {
      await rename(staged.staging, staged.final)
    } catch (error) {
      await rm(staged.staging, { force: true }).catch(() => {})
      throw error
    }
  }
  try {
    input.db.transaction((tx) => {
      if (existing.length > 0) {
        tx.delete(messageArtifacts)
          .where(
            and(eq(messageArtifacts.messageId, input.messageId), eq(messageArtifacts.kind, kind))
          )
          .run()
      }
      tx.insert(messageArtifacts)
        .values({
          id,
          messageId: input.messageId,
          kind,
          contentHash,
          byteSize,
          storage,
          contentInline,
          contentPath,
          createdAt,
          expiresAt: input.expiresAt ?? null
        })
        .run()
    })
  } catch (error) {
    if (staged) await rm(staged.final, { force: true }).catch(() => {})
    throw error
  }

  for (const row of existing) {
    if (row.storage !== 'file' || !row.contentPath) continue
    const oldPath = safeMessageArtifactPath(input.dataDir, row.contentPath)
    if (oldPath) await rm(oldPath, { force: true }).catch(() => {})
  }

  signalArtifactExpiry(input.expiresAt)

  return id
}

export async function getMessageArtifactPayload<T = unknown>(
  db: AppDatabase,
  dataDir: string,
  artifactId: string
): Promise<T | null> {
  const rows = await db
    .select()
    .from(messageArtifacts)
    .where(eq(messageArtifacts.id, artifactId))
    .limit(1)
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
    const raw = await readMessageArtifactFile(dataDir, row.contentPath)
    if (!raw) return null
    try {
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }

  return null
}

export async function deleteMessageArtifactFiles(
  dataDir: string,
  messageId: string
): Promise<void> {
  await rm(messageArtifactDir(dataDir, messageId), {
    recursive: true,
    force: true
  }).catch(() => {})
}

export async function deleteExpiredMessageArtifacts(
  db: AppDatabase,
  dataDir: string,
  cutoff = nowSec()
): Promise<{ deleted: number; deletedBytes: number }> {
  const rows = await db
    .select()
    .from(messageArtifacts)
    .where(lte(messageArtifacts.expiresAt, cutoff))
    .limit(250)
  if (rows.length === 0) return { deleted: 0, deletedBytes: 0 }
  await db.delete(messageArtifacts).where(
    inArray(
      messageArtifacts.id,
      rows.map((row) => row.id)
    )
  )
  await Promise.all(
    rows.map(async (row) => {
      if (row.storage !== 'file' || !row.contentPath) return
      const path = safeMessageArtifactPath(dataDir, row.contentPath)
      if (path) await rm(path, { force: true }).catch(() => {})
    })
  )
  return {
    deleted: rows.length,
    deletedBytes: rows.reduce((total, row) => total + row.byteSize, 0)
  }
}
