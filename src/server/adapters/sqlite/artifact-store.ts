/**
 * ArtifactStore over sqlite meta + filesystem bytes.
 * Never stores file contents in SQLite (meta only via SqliteArtifactRepository).
 */

import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ArtifactMeta,
  ArtifactStore,
  ArtifactWriteHandle
} from '../../core/application/ports/artifact-store'
import type { SqliteDatabase } from './migrate-core'
import { SqliteArtifactRepository } from './repositories/artifact-repository'

const ARTIFACT_PROJECT_ID = '_artifact'

function safeArtifactFileName(id: string): string {
  return id.replace(/[/\\]/g, '_')
}

function isIncompletePayload(payloadJson: string): boolean {
  try {
    const parsed = JSON.parse(payloadJson) as unknown
    return (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      (parsed as { incomplete?: unknown }).incomplete === true
    )
  } catch {
    return false
  }
}

function toArtifactMeta(row: {
  id: string
  kind: string
  contentSha256: string
  createdAtMs: number
  payloadJson: string
}): ArtifactMeta {
  const incomplete = isIncompletePayload(row.payloadJson)
  return {
    id: row.id,
    kind: row.kind,
    ...(row.contentSha256 ? { contentHash: row.contentSha256 } : {}),
    createdAtMs: row.createdAtMs,
    ...(incomplete ? { incomplete: true } : { incomplete: false })
  }
}

export class SqliteArtifactStore implements ArtifactStore {
  private readonly artifacts: SqliteArtifactRepository
  private readonly artifactsDir: string

  constructor(
    private readonly db: SqliteDatabase,
    artifactsDir: string
  ) {
    mkdirSync(artifactsDir, { recursive: true })
    this.artifacts = new SqliteArtifactRepository(db)
    this.artifactsDir = artifactsDir
  }

  private filePath(id: string): string {
    return join(this.artifactsDir, safeArtifactFileName(id))
  }

  async putMeta(meta: ArtifactMeta): Promise<void> {
    const existing = this.artifacts.get(meta.id)
    const now = Date.now()
    const incomplete = meta.incomplete === true
    this.artifacts.saveMeta({
      id: meta.id,
      projectId: existing?.projectId ?? ARTIFACT_PROJECT_ID,
      jobId: existing?.jobId ?? null,
      kind: meta.kind,
      storagePath: existing?.storagePath ?? '',
      contentSha256: meta.contentHash ?? existing?.contentSha256 ?? '',
      byteSize: existing?.byteSize ?? 0,
      payloadJson: JSON.stringify(incomplete ? { incomplete: true } : {}),
      createdAtMs: meta.createdAtMs ?? existing?.createdAtMs ?? now,
      updatedAtMs: now,
      expiresAtMs: existing?.expiresAtMs ?? null,
      deletedAtMs: existing?.deletedAtMs ?? null
    })
  }

  async getMeta(id: string): Promise<ArtifactMeta | undefined> {
    const row = this.artifacts.get(id)
    if (!row || row.projectId !== ARTIFACT_PROJECT_ID) return undefined
    return toArtifactMeta(row)
  }

  async beginWrite(id: string, kind: string): Promise<ArtifactWriteHandle> {
    const chunks: Buffer[] = []
    const now = Date.now()
    this.artifacts.saveMeta({
      id,
      projectId: ARTIFACT_PROJECT_ID,
      jobId: null,
      kind,
      storagePath: '',
      contentSha256: '',
      byteSize: 0,
      payloadJson: JSON.stringify({ incomplete: true }),
      createdAtMs: now,
      updatedAtMs: now,
      expiresAtMs: null,
      deletedAtMs: null
    })

    return {
      id,
      writeChunk: async (chunk: Uint8Array | string): Promise<void> => {
        const buf =
          typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
        chunks.push(buf)
      },
      commit: async (meta?: Partial<ArtifactMeta>): Promise<ArtifactMeta> => {
        const content = Buffer.concat(chunks)
        const path = this.filePath(id)
        writeFileSync(path, content)
        const createdAtMs = meta?.createdAtMs ?? Date.now()
        const finalMeta: ArtifactMeta = {
          id,
          kind,
          incomplete: false,
          ...(meta?.contentHash !== undefined
            ? { contentHash: meta.contentHash }
            : {}),
          createdAtMs
        }
        this.artifacts.saveMeta({
          id,
          projectId: ARTIFACT_PROJECT_ID,
          jobId: null,
          kind,
          storagePath: path,
          contentSha256: meta?.contentHash ?? '',
          byteSize: content.byteLength,
          payloadJson: '{}',
          createdAtMs,
          updatedAtMs: Date.now(),
          expiresAtMs: null,
          deletedAtMs: null
        })
        return finalMeta
      },
      abort: async (): Promise<void> => {
        this.db.prepare(`DELETE FROM core_artifacts WHERE id = ?`).run(id)
        try {
          unlinkSync(this.filePath(id))
        } catch {
          // file may not exist yet
        }
      }
    }
  }
}
