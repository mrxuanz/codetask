import type Database from 'better-sqlite3'
import type { QueueEntryDto } from '@codetask/contracts'
import type { QueueEntry } from '../domain/queue-entry.ts'
import { isoFromMs } from '../../shared.ts'

function mapRow(row: Record<string, unknown>): QueueEntry {
  return {
    jobId: row.job_id as string,
    generation: row.generation as number,
    status: row.status as QueueEntry['status'],
    priority: row.priority as number,
    sequence: row.sequence as number,
    enqueuedAt: row.enqueued_at as number,
    claimedAt: (row.claimed_at as number | null) ?? null,
    removedAt: (row.removed_at as number | null) ?? null
  }
}

export class QueueRepository {
  constructor(private readonly db: Database.Database) {}

  getPosition(jobId: string, generation: number): number | null {
    const current = this.db
      .prepare(
        `SELECT status, priority, sequence FROM execution_queue_entries
         WHERE job_id = ? AND generation = ?`
      )
      .get(jobId, generation) as { status: string; priority: number; sequence: number } | undefined
    if (!current || current.status !== 'queued') return null
    const row = this.db
      .prepare(
        `SELECT COUNT(*) + 1 AS position FROM execution_queue_entries ahead
         WHERE ahead.status = 'queued'
           AND (
             ahead.priority > ?
             OR (ahead.priority = ? AND ahead.sequence < ?)
             OR (ahead.priority = ? AND ahead.sequence = ? AND ahead.job_id < ?)
           )`
      )
      .get(
        current.priority,
        current.priority,
        current.sequence,
        current.priority,
        current.sequence,
        jobId
      ) as { position: number }
    return row.position
  }

  listQueued(): QueueEntryDto[] {
    const rows = this.db
      .prepare(
        `SELECT q.*, j.title, j.state FROM execution_queue_entries q
         JOIN jobs j ON j.id = q.job_id
         WHERE q.status = 'queued'
         ORDER BY q.priority DESC, q.enqueued_at ASC, q.sequence ASC, q.job_id ASC`
      )
      .all() as Array<Record<string, unknown>>

    return rows.map((row, index) => ({
      jobId: row.job_id as string,
      generation: row.generation as number,
      status: row.status as string,
      priority: row.priority as number,
      sequence: row.sequence as number,
      position: index + 1,
      enqueuedAt: isoFromMs(row.enqueued_at as number),
      title: row.title as string,
      state: row.state as QueueEntryDto['state']
    }))
  }

  nextSequence(): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM execution_queue_entries`)
      .get() as { next: number }
    return row.next
  }

  getEntry(jobId: string, generation: number): QueueEntry | null {
    const row = this.db
      .prepare(`SELECT * FROM execution_queue_entries WHERE job_id = ? AND generation = ?`)
      .get(jobId, generation) as Record<string, unknown> | undefined
    return row ? mapRow(row) : null
  }
}
