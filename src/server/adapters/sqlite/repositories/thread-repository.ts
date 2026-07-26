import type { SqliteDatabase } from '../migrate-core'
import type { CasResult, CoreThreadRecord, ThreadRepository } from '../ports'

type ThreadRow = {
  id: string
  project_id: string
  owner_user_id: string
  status: string
  revision: number
  draft_id: string | null
  plan_id: string | null
  job_id: string | null
  title: string | null
  payload_json: string
  created_at_ms: number
  updated_at_ms: number
}

function mapRow(row: ThreadRow): CoreThreadRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    ownerUserId: row.owner_user_id,
    status: row.status,
    revision: row.revision,
    draftId: row.draft_id,
    planId: row.plan_id,
    jobId: row.job_id,
    title: row.title,
    payloadJson: row.payload_json,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms
  }
}

export class SqliteThreadRepository implements ThreadRepository {
  constructor(private readonly db: SqliteDatabase) {}

  get(id: string): CoreThreadRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, owner_user_id, status, revision, draft_id, plan_id, job_id,
                title, payload_json, created_at_ms, updated_at_ms
         FROM core_threads WHERE id = ?`
      )
      .get(id) as ThreadRow | undefined
    return row ? mapRow(row) : null
  }

  save(row: CoreThreadRecord): void {
    this.db
      .prepare(
        `INSERT INTO core_threads(
           id, project_id, owner_user_id, status, revision, draft_id, plan_id, job_id,
           title, payload_json, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           owner_user_id = excluded.owner_user_id,
           status = excluded.status,
           revision = excluded.revision,
           draft_id = excluded.draft_id,
           plan_id = excluded.plan_id,
           job_id = excluded.job_id,
           title = excluded.title,
           payload_json = excluded.payload_json,
           updated_at_ms = excluded.updated_at_ms`
      )
      .run(
        row.id,
        row.projectId,
        row.ownerUserId,
        row.status,
        row.revision,
        row.draftId,
        row.planId,
        row.jobId,
        row.title,
        row.payloadJson,
        row.createdAtMs,
        row.updatedAtMs
      )
  }

  compareAndSet(input: {
    readonly id: string
    readonly expectedRevision: number
    readonly next: Omit<CoreThreadRecord, 'id' | 'revision' | 'createdAtMs'> & {
      readonly revision?: number
    }
  }): CasResult {
    const newRevision = input.expectedRevision + 1
    const result = this.db
      .prepare(
        `UPDATE core_threads SET
           project_id = ?,
           owner_user_id = ?,
           status = ?,
           revision = ?,
           draft_id = ?,
           plan_id = ?,
           job_id = ?,
           title = ?,
           payload_json = ?,
           updated_at_ms = ?
         WHERE id = ? AND revision = ?`
      )
      .run(
        input.next.projectId,
        input.next.ownerUserId,
        input.next.status,
        newRevision,
        input.next.draftId,
        input.next.planId,
        input.next.jobId,
        input.next.title,
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
