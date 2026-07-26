import type { SqliteDatabase } from '../migrate-core'
import type { CasResult, CoreDraftRecord, DraftRepository } from '../ports'

type DraftRow = {
  id: string
  project_id: string
  thread_id: string
  status: string
  revision: number
  content: string
  payload_json: string
  created_at_ms: number
  updated_at_ms: number
}

function mapRow(row: DraftRow): CoreDraftRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    threadId: row.thread_id,
    status: row.status,
    revision: row.revision,
    content: row.content,
    payloadJson: row.payload_json,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms
  }
}

export class SqliteDraftRepository implements DraftRepository {
  constructor(private readonly db: SqliteDatabase) {}

  get(id: string): CoreDraftRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, thread_id, status, revision, content, payload_json,
                created_at_ms, updated_at_ms
         FROM core_drafts WHERE id = ?`
      )
      .get(id) as DraftRow | undefined
    return row ? mapRow(row) : null
  }

  save(row: CoreDraftRecord): void {
    this.db
      .prepare(
        `INSERT INTO core_drafts(
           id, project_id, thread_id, status, revision, content, payload_json,
           created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           thread_id = excluded.thread_id,
           status = excluded.status,
           revision = excluded.revision,
           content = excluded.content,
           payload_json = excluded.payload_json,
           updated_at_ms = excluded.updated_at_ms`
      )
      .run(
        row.id,
        row.projectId,
        row.threadId,
        row.status,
        row.revision,
        row.content,
        row.payloadJson,
        row.createdAtMs,
        row.updatedAtMs
      )
  }

  compareAndSet(input: {
    readonly id: string
    readonly expectedRevision: number
    readonly next: Omit<CoreDraftRecord, 'id' | 'revision' | 'createdAtMs'> & {
      readonly revision?: number
    }
  }): CasResult {
    const newRevision = input.expectedRevision + 1
    const result = this.db
      .prepare(
        `UPDATE core_drafts SET
           project_id = ?,
           thread_id = ?,
           status = ?,
           revision = ?,
           content = ?,
           payload_json = ?,
           updated_at_ms = ?
         WHERE id = ? AND revision = ?`
      )
      .run(
        input.next.projectId,
        input.next.threadId,
        input.next.status,
        newRevision,
        input.next.content,
        input.next.payloadJson,
        input.next.updatedAtMs,
        input.id,
        input.expectedRevision
      )
    return result.changes === 1
      ? { ok: true, newRevision }
      : { ok: false, reason: 'revision_conflict' }
  }
}
