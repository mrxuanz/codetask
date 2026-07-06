import { createHash, randomUUID } from 'crypto'
import { gunzipSync, gzipSync } from 'zlib'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { and, eq } from 'drizzle-orm'
import { DEFAULT_RETENTION_SETTINGS } from '../../shared/contracts/retention.ts'
import type { RetentionSettings } from '../../shared/contracts/retention.ts'
import type { getDb } from '../db'
import { messageArtifacts } from '../db/schema'

type AppDatabase = ReturnType<typeof getDb>

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function hashContent(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

export function messageArtifactFileRelPath(messageId: string, artifactId: string): string {
  return join('artifacts', 'messages', messageId, `${artifactId}.json.gz`)
}

function messageArtifactFileAbsPath(
  dataDir: string,
  messageId: string,
  artifactId: string
): string {
  return join(dataDir, messageArtifactFileRelPath(messageId, artifactId))
}

async function writeMessageArtifactFile(
  dataDir: string,
  messageId: string,
  artifactId: string,
  raw: string
): Promise<void> {
  const abs = messageArtifactFileAbsPath(dataDir, messageId, artifactId)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, gzipSync(raw))
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

  if (byteSize > inlineMax) {
    storage = 'file'
    contentInline = null
    contentPath = messageArtifactFileRelPath(input.messageId, id)
    await writeMessageArtifactFile(input.dataDir, input.messageId, id, raw)
  }

  const existing = await input.db
    .select()
    .from(messageArtifacts)
    .where(and(eq(messageArtifacts.messageId, input.messageId), eq(messageArtifacts.kind, kind)))

  for (const row of existing) {
    if (row.storage === 'file' && row.contentPath) {
      await rm(join(input.dataDir, row.contentPath.replace(/\\/g, '/')), { force: true }).catch(
        () => {}
      )
    }
  }
  if (existing.length > 0) {
    await input.db
      .delete(messageArtifacts)
      .where(and(eq(messageArtifacts.messageId, input.messageId), eq(messageArtifacts.kind, kind)))
  }

  await input.db.insert(messageArtifacts).values({
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
  await rm(join(dataDir, 'artifacts', 'messages', messageId), {
    recursive: true,
    force: true
  }).catch(() => {})
}
