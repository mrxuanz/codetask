import type { SqliteDatabase } from '../migrate-core'
import type { CasResult, CoreJobRecord, JobRepository } from '../ports'

type JobRow = {
  id: string
  project_id: string
  thread_id: string
  plan_id: string | null
  status: string
  revision: number
  plan_revision: number
  execution_generation: number
  payload_json: string
  created_at_ms: number
  updated_at_ms: number
  terminal_at_ms: number | null
}

function mapRow(row: JobRow): CoreJobRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    threadId: row.thread_id,
    planId: row.plan_id,
    status: row.status,
    revision: row.revision,
    planRevision: row.plan_revision,
    executionGeneration: row.execution_generation,
    payloadJson: row.payload_json,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    terminalAtMs: row.terminal_at_ms
  }
}

export class SqliteJobRepository implements JobRepository {
  constructor(private readonly db: SqliteDatabase) {}

  get(id: string): CoreJobRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, thread_id, plan_id, status, revision, plan_revision,
                execution_generation, payload_json, created_at_ms, updated_at_ms, terminal_at_ms
         FROM core_jobs WHERE id = ?`
      )
      .get(id) as JobRow | undefined
    return row ? mapRow(row) : null
  }

  save(row: CoreJobRecord): void {
    this.db
      .prepare(
        `INSERT INTO core_jobs(
           id, project_id, thread_id, plan_id, status, revision, plan_revision,
           execution_generation, payload_json, created_at_ms, updated_at_ms, terminal_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           thread_id = excluded.thread_id,
           plan_id = excluded.plan_id,
           status = excluded.status,
           revision = excluded.revision,
           plan_revision = excluded.plan_revision,
           execution_generation = excluded.execution_generation,
           payload_json = excluded.payload_json,
           updated_at_ms = excluded.updated_at_ms,
           terminal_at_ms = excluded.terminal_at_ms`
      )
      .run(
        row.id,
        row.projectId,
        row.threadId,
        row.planId,
        row.status,
        row.revision,
        row.planRevision,
        row.executionGeneration,
        row.payloadJson,
        row.createdAtMs,
        row.updatedAtMs,
        row.terminalAtMs
      )
  }

  compareAndSet(input: {
    readonly id: string
    readonly expectedRevision: number
    readonly expectedStatus?: string
    readonly next: {
      readonly status: string
      readonly planRevision?: number
      readonly executionGeneration?: number
      readonly payloadJson?: string
      readonly terminalAtMs?: number | null
      readonly updatedAtMs: number
      readonly planId?: string | null
    }
  }): CasResult {
    const current = this.get(input.id)
    if (!current || current.revision !== input.expectedRevision) {
      return { ok: false, reason: 'revision_conflict' }
    }
    if (input.expectedStatus !== undefined && current.status !== input.expectedStatus) {
      return { ok: false, reason: 'revision_conflict' }
    }

    const newRevision = input.expectedRevision + 1
    const result = this.db
      .prepare(
        `UPDATE core_jobs SET
           status = ?,
           revision = ?,
           plan_revision = COALESCE(?, plan_revision),
           execution_generation = COALESCE(?, execution_generation),
           payload_json = COALESCE(?, payload_json),
           terminal_at_ms = ?,
           plan_id = COALESCE(?, plan_id),
           updated_at_ms = ?
         WHERE id = ? AND revision = ?`
      )
      .run(
        input.next.status,
        newRevision,
        input.next.planRevision ?? null,
        input.next.executionGeneration ?? null,
        input.next.payloadJson ?? null,
        input.next.terminalAtMs !== undefined ? input.next.terminalAtMs : current.terminalAtMs,
        input.next.planId !== undefined ? input.next.planId : null,
        input.next.updatedAtMs,
        input.id,
        input.expectedRevision
      )

    return result.changes === 1
      ? { ok: true, newRevision }
      : { ok: false, reason: 'revision_conflict' }
  }
}
