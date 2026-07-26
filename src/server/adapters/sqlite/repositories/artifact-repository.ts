import type { SqliteDatabase } from '../migrate-core'
import type { ArtifactRepository, CoreArtifactRecord } from '../ports'

type ArtifactRow = {
  id: string
  project_id: string
  job_id: string | null
  kind: string
  storage_path: string
  content_sha256: string
  byte_size: number
  payload_json: string
  created_at_ms: number
  updated_at_ms: number
  expires_at_ms: number | null
  deleted_at_ms: number | null
}

function mapRow(row: ArtifactRow): CoreArtifactRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    jobId: row.job_id,
    kind: row.kind,
    storagePath: row.storage_path,
    contentSha256: row.content_sha256,
    byteSize: row.byte_size,
    payloadJson: row.payload_json,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    expiresAtMs: row.expires_at_ms,
    deletedAtMs: row.deleted_at_ms
  }
}

/**
 * Artifact metadata repository — never stores file bytes in SQLite.
 * @see schema/core-tables.ts no-unbounded-BLOB policy
 */
export class SqliteArtifactRepository implements ArtifactRepository {
  constructor(private readonly db: SqliteDatabase) {}

  get(id: string): CoreArtifactRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, job_id, kind, storage_path, content_sha256, byte_size,
                payload_json, created_at_ms, updated_at_ms, expires_at_ms, deleted_at_ms
         FROM core_artifacts WHERE id = ?`
      )
      .get(id) as ArtifactRow | undefined
    return row ? mapRow(row) : null
  }

  saveMeta(row: CoreArtifactRecord): void {
    this.db
      .prepare(
        `INSERT INTO core_artifacts(
           id, project_id, job_id, kind, storage_path, content_sha256, byte_size,
           payload_json, created_at_ms, updated_at_ms, expires_at_ms, deleted_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           job_id = excluded.job_id,
           kind = excluded.kind,
           storage_path = excluded.storage_path,
           content_sha256 = excluded.content_sha256,
           byte_size = excluded.byte_size,
           payload_json = excluded.payload_json,
           updated_at_ms = excluded.updated_at_ms,
           expires_at_ms = excluded.expires_at_ms,
           deleted_at_ms = excluded.deleted_at_ms`
      )
      .run(
        row.id,
        row.projectId,
        row.jobId,
        row.kind,
        row.storagePath,
        row.contentSha256,
        row.byteSize,
        row.payloadJson,
        row.createdAtMs,
        row.updatedAtMs,
        row.expiresAtMs,
        row.deletedAtMs
      )
  }

  softDelete(input: { readonly id: string; readonly deletedAtMs: number }): void {
    this.db
      .prepare(
        `UPDATE core_artifacts
         SET deleted_at_ms = ?, updated_at_ms = ?
         WHERE id = ?`
      )
      .run(input.deletedAtMs, input.deletedAtMs, input.id)
  }
}
