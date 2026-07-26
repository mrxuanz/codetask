import type { SqliteDatabase } from '../migrate-core'
import type { CoreOutboxRecord, OutboxRepository } from '../ports'

type OutboxRow = {
  id: number
  topic: string
  event_type: string
  entity_id: string
  aggregate_revision: number
  payload_json: string
  status: string
  claimed_by: string | null
  claimed_at_ms: number | null
  available_at_ms: number
  created_at_ms: number
  acked_at_ms: number | null
}

function mapRow(row: OutboxRow): CoreOutboxRecord {
  return {
    id: row.id,
    topic: row.topic,
    eventType: row.event_type,
    entityId: row.entity_id,
    aggregateRevision: row.aggregate_revision,
    payloadJson: row.payload_json,
    status: row.status,
    claimedBy: row.claimed_by,
    claimedAtMs: row.claimed_at_ms,
    availableAtMs: row.available_at_ms,
    createdAtMs: row.created_at_ms,
    ackedAtMs: row.acked_at_ms
  }
}

export class SqliteOutboxRepository implements OutboxRepository {
  constructor(private readonly db: SqliteDatabase) {}

  append(input: {
    readonly topic: string
    readonly eventType: string
    readonly entityId: string
    readonly aggregateRevision: number
    readonly payloadJson: string
    readonly createdAtMs: number
    readonly availableAtMs?: number
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO core_outbox(
           topic, event_type, entity_id, aggregate_revision, payload_json,
           status, available_at_ms, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .run(
        input.topic,
        input.eventType,
        input.entityId,
        input.aggregateRevision,
        input.payloadJson,
        input.availableAtMs ?? input.createdAtMs,
        input.createdAtMs
      )
    return Number(result.lastInsertRowid)
  }

  claim(input: {
    readonly limit: number
    readonly claimedBy: string
    readonly nowMs: number
  }): readonly CoreOutboxRecord[] {
    const claim = this.db.transaction(() => {
      const candidates = this.db
        .prepare(
          `SELECT id FROM core_outbox
           WHERE status = 'pending' AND available_at_ms <= ?
           ORDER BY id ASC
           LIMIT ?`
        )
        .all(input.nowMs, input.limit) as Array<{ id: number }>

      if (candidates.length === 0) return [] as CoreOutboxRecord[]

      const update = this.db.prepare(
        `UPDATE core_outbox
         SET status = 'claimed', claimed_by = ?, claimed_at_ms = ?
         WHERE id = ? AND status = 'pending'`
      )

      const claimedIds: number[] = []
      for (const row of candidates) {
        const result = update.run(input.claimedBy, input.nowMs, row.id)
        if (result.changes === 1) claimedIds.push(row.id)
      }

      if (claimedIds.length === 0) return [] as CoreOutboxRecord[]

      const placeholders = claimedIds.map(() => '?').join(', ')
      const rows = this.db
        .prepare(
          `SELECT id, topic, event_type, entity_id, aggregate_revision, payload_json,
                  status, claimed_by, claimed_at_ms, available_at_ms, created_at_ms, acked_at_ms
           FROM core_outbox
           WHERE id IN (${placeholders})
           ORDER BY id ASC`
        )
        .all(...claimedIds) as OutboxRow[]
      return rows.map(mapRow)
    })
    return claim()
  }

  ack(input: { readonly ids: readonly number[]; readonly ackedAtMs: number }): void {
    if (input.ids.length === 0) return
    const placeholders = input.ids.map(() => '?').join(', ')
    this.db
      .prepare(
        `UPDATE core_outbox
         SET status = 'acked', acked_at_ms = ?
         WHERE id IN (${placeholders}) AND status = 'claimed'`
      )
      .run(input.ackedAtMs, ...input.ids)
  }

  listPending(limit: number): readonly CoreOutboxRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, topic, event_type, entity_id, aggregate_revision, payload_json,
                status, claimed_by, claimed_at_ms, available_at_ms, created_at_ms, acked_at_ms
         FROM core_outbox
         WHERE status = 'pending'
         ORDER BY id ASC
         LIMIT ?`
      )
      .all(limit) as OutboxRow[]
    return rows.map(mapRow)
  }
}
