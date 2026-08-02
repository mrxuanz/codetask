import type Database from 'better-sqlite3'
import { newId, nowMs } from '../shared.ts'
import type { ExecutionOutboxEvent } from './job-events.ts'

export type ExecutionOutboxListener = (
  jobId: string,
  eventType: string,
  payload: unknown,
  outboxId: string
) => void

export class ExecutionOutbox {
  constructor(
    private readonly db: Database.Database,
    private readonly onEvent?: ExecutionOutboxListener
  ) {}

  enqueue(jobId: string, eventType: string, payload: unknown, tx?: Database.Database): void {
    const db = tx ?? this.db
    const id = newId('outbox')
    const createdAt = nowMs()
    db.prepare(
      `INSERT INTO execution_outbox (id, job_id, event_type, payload_json, created_at, attempts)
       VALUES (?, ?, ?, ?, ?, 0)`
    ).run(id, jobId, eventType, JSON.stringify(payload), createdAt)
  }

  drainOnce(limit = 50): number {
    const rows = this.db
      .prepare(
        `SELECT * FROM execution_outbox WHERE dispatched_at IS NULL
         ORDER BY created_at ASC LIMIT ?`
      )
      .all(limit) as Array<Record<string, unknown>>

    let dispatched = 0
    const now = nowMs()
    for (const row of rows) {
      const event = row as ExecutionOutboxEvent
      try {
        this.onEvent?.(
          event.jobId,
          event.eventType,
          JSON.parse(event.payloadJson),
          event.id
        )
        this.db
          .prepare(`UPDATE execution_outbox SET dispatched_at = ? WHERE id = ?`)
          .run(now, event.id)
        dispatched += 1
      } catch (error) {
        this.db
          .prepare(
            `UPDATE execution_outbox SET attempts = attempts + 1, last_error_json = ? WHERE id = ?`
          )
          .run(
            JSON.stringify({ message: error instanceof Error ? error.message : String(error) }),
            event.id
          )
      }
    }
    return dispatched
  }
}
