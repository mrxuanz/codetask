import type { SqliteDatabase } from '../migrate-core'
import type { AttemptRepository, CoreTaskAttemptRecord } from '../ports'

type AttemptRow = {
  id: string
  task_id: string
  job_id: string
  status: string
  execution_generation: number
  idempotency_key: string
  result_hash: string | null
  error_code: string | null
  payload_json: string
  created_at_ms: number
  updated_at_ms: number
}

function mapRow(row: AttemptRow): CoreTaskAttemptRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    jobId: row.job_id,
    status: row.status,
    executionGeneration: row.execution_generation,
    idempotencyKey: row.idempotency_key,
    resultHash: row.result_hash,
    errorCode: row.error_code,
    payloadJson: row.payload_json,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms
  }
}

const SELECT_COLS = `id, task_id, job_id, status, execution_generation, idempotency_key,
                result_hash, error_code, payload_json, created_at_ms, updated_at_ms`

export class SqliteAttemptRepository implements AttemptRepository {
  constructor(private readonly db: SqliteDatabase) {}

  get(id: string): CoreTaskAttemptRecord | null {
    const row = this.db
      .prepare(`SELECT ${SELECT_COLS} FROM core_task_attempts WHERE id = ?`)
      .get(id) as AttemptRow | undefined
    return row ? mapRow(row) : null
  }

  save(row: CoreTaskAttemptRecord): void {
    this.db
      .prepare(
        `INSERT INTO core_task_attempts(
           id, task_id, job_id, status, execution_generation, idempotency_key,
           result_hash, error_code, payload_json, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           task_id = excluded.task_id,
           job_id = excluded.job_id,
           status = excluded.status,
           execution_generation = excluded.execution_generation,
           idempotency_key = excluded.idempotency_key,
           result_hash = excluded.result_hash,
           error_code = excluded.error_code,
           payload_json = excluded.payload_json,
           updated_at_ms = excluded.updated_at_ms`
      )
      .run(
        row.id,
        row.taskId,
        row.jobId,
        row.status,
        row.executionGeneration,
        row.idempotencyKey,
        row.resultHash,
        row.errorCode,
        row.payloadJson,
        row.createdAtMs,
        row.updatedAtMs
      )
  }

  listForTask(
    jobId: string,
    taskId: string,
    executionGeneration: number
  ): readonly CoreTaskAttemptRecord[] {
    const rows = this.db
      .prepare(
        `SELECT ${SELECT_COLS}
         FROM core_task_attempts
         WHERE job_id = ? AND task_id = ? AND execution_generation = ?
         ORDER BY id`
      )
      .all(jobId, taskId, executionGeneration) as AttemptRow[]
    return rows.map(mapRow)
  }

  listNonTerminal(): readonly CoreTaskAttemptRecord[] {
    const rows = this.db
      .prepare(
        `SELECT ${SELECT_COLS}
         FROM core_task_attempts
         WHERE status NOT IN ('succeeded', 'failed', 'inconclusive')
         ORDER BY id`
      )
      .all() as AttemptRow[]
    return rows.map(mapRow)
  }
}
