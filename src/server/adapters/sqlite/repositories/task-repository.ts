import type { SqliteDatabase } from '../migrate-core'
import type { CasResult, CoreTaskRecord, TaskRepository } from '../ports'

type TaskRow = {
  id: string
  project_id: string
  job_id: string
  plan_node_id: string | null
  status: string
  revision: number
  title: string | null
  dependency_ids_json: string
  payload_json: string
  created_at_ms: number
  updated_at_ms: number
}

function mapRow(row: TaskRow): CoreTaskRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    jobId: row.job_id,
    planNodeId: row.plan_node_id,
    status: row.status,
    revision: row.revision,
    title: row.title,
    dependencyIdsJson: row.dependency_ids_json,
    payloadJson: row.payload_json,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms
  }
}

export class SqliteTaskRepository implements TaskRepository {
  constructor(private readonly db: SqliteDatabase) {}

  get(id: string): CoreTaskRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, job_id, plan_node_id, status, revision, title,
                dependency_ids_json, payload_json, created_at_ms, updated_at_ms
         FROM core_tasks WHERE id = ?`
      )
      .get(id) as TaskRow | undefined
    return row ? mapRow(row) : null
  }

  save(row: CoreTaskRecord): void {
    this.db
      .prepare(
        `INSERT INTO core_tasks(
           id, project_id, job_id, plan_node_id, status, revision, title,
           dependency_ids_json, payload_json, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           job_id = excluded.job_id,
           plan_node_id = excluded.plan_node_id,
           status = excluded.status,
           revision = excluded.revision,
           title = excluded.title,
           dependency_ids_json = excluded.dependency_ids_json,
           payload_json = excluded.payload_json,
           updated_at_ms = excluded.updated_at_ms`
      )
      .run(
        row.id,
        row.projectId,
        row.jobId,
        row.planNodeId,
        row.status,
        row.revision,
        row.title,
        row.dependencyIdsJson,
        row.payloadJson,
        row.createdAtMs,
        row.updatedAtMs
      )
  }

  listByJob(jobId: string): readonly CoreTaskRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, job_id, plan_node_id, status, revision, title,
                dependency_ids_json, payload_json, created_at_ms, updated_at_ms
         FROM core_tasks WHERE job_id = ? ORDER BY id`
      )
      .all(jobId) as TaskRow[]
    return rows.map(mapRow)
  }

  compareAndSet(input: {
    readonly id: string
    readonly expectedRevision: number
    readonly next: Omit<CoreTaskRecord, 'id' | 'revision' | 'createdAtMs'> & {
      readonly revision?: number
    }
  }): CasResult {
    const newRevision = input.expectedRevision + 1
    const result = this.db
      .prepare(
        `UPDATE core_tasks SET
           project_id = ?,
           job_id = ?,
           plan_node_id = ?,
           status = ?,
           revision = ?,
           title = ?,
           dependency_ids_json = ?,
           payload_json = ?,
           updated_at_ms = ?
         WHERE id = ? AND revision = ?`
      )
      .run(
        input.next.projectId,
        input.next.jobId,
        input.next.planNodeId,
        input.next.status,
        newRevision,
        input.next.title,
        input.next.dependencyIdsJson,
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
