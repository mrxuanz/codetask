import type Database from 'better-sqlite3'
import type { DurableRealtimeEnvelope, RealtimeTopic } from '@codetask/contracts'

export type RealtimeEventRow = {
  event_id: number
  actor_id: string
  source_module: string
  source_outbox_id: string
  topic: string
  event_type: string
  entity_id: string
  entity_revision: number
  payload_json: string
  occurred_at: number
  expires_at: number
}

export type AppendRealtimeEventInput = {
  actorId: string
  sourceModule: string
  sourceOutboxId: string
  topic: RealtimeTopic | string
  eventType: string
  entityId: string
  entityRevision: number
  payload: unknown
  occurredAt?: number
  /** Retention window; default 7 days. */
  ttlMs?: number
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_PAYLOAD_BYTES = 32 * 1024

export class RealtimeEventLog {
  constructor(private readonly db: Database.Database) {}

  /**
   * Idempotent append by (source_module, source_outbox_id).
   * Returns the durable envelope (existing or newly inserted).
   */
  append(input: AppendRealtimeEventInput): DurableRealtimeEnvelope {
    const occurredAt = input.occurredAt ?? Date.now()
    const expiresAt = occurredAt + (input.ttlMs ?? DEFAULT_TTL_MS)
    const payloadJson = JSON.stringify(input.payload ?? {})
    if (Buffer.byteLength(payloadJson, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new Error('realtime.payload_too_large')
    }

    const existing = this.db
      .prepare(
        `SELECT * FROM realtime_events
          WHERE source_module = ? AND source_outbox_id = ?`
      )
      .get(input.sourceModule, input.sourceOutboxId) as RealtimeEventRow | undefined

    if (existing) {
      return this.toEnvelope(existing)
    }

    const result = this.db
      .prepare(
        `INSERT INTO realtime_events (
           actor_id, source_module, source_outbox_id, topic, event_type,
           entity_id, entity_revision, payload_json, occurred_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.actorId,
        input.sourceModule,
        input.sourceOutboxId,
        input.topic,
        input.eventType,
        input.entityId,
        input.entityRevision,
        payloadJson,
        occurredAt,
        expiresAt
      )

    const eventId = Number(result.lastInsertRowid)
    return {
      eventId,
      ephemeral: false,
      topic: input.topic,
      type: input.eventType,
      entityId: input.entityId,
      entityRevision: input.entityRevision,
      occurredAt,
      payload: input.payload ?? {}
    }
  }

  /**
   * Replay durable events for an actor across subscribed topics after lastEventId.
   * Returns null when the cursor is behind the retention window (client must resync).
   * `settings:self` events are global and not actor-scoped.
   */
  replayAfter(input: {
    actorId: string
    topics: readonly string[]
    afterEventId: number
    limit?: number
  }): { events: DurableRealtimeEnvelope[]; latestEventId: number; gap: boolean } {
    const topics = [...new Set(input.topics)].filter(Boolean)
    const latestRow = this.db
      .prepare(
        `SELECT MAX(event_id) AS max_id FROM realtime_events
          WHERE actor_id = ? OR topic = 'settings:self'`
      )
      .get(input.actorId) as { max_id: number | null } | undefined
    const latestEventId = latestRow?.max_id ?? 0

    if (topics.length === 0) {
      return { events: [], latestEventId, gap: false }
    }

    if (input.afterEventId > 0) {
      const oldest = this.db
        .prepare(
          `SELECT MIN(event_id) AS min_id FROM realtime_events
            WHERE topic IN (${topics.map(() => '?').join(',')})
              AND (actor_id = ? OR topic = 'settings:self')`
        )
        .get(...topics, input.actorId) as { min_id: number | null } | undefined
      const oldestId = oldest?.min_id
      if (oldestId != null && input.afterEventId + 1 < oldestId) {
        return { events: [], latestEventId, gap: true }
      }
    }

    const limit = input.limit ?? 500
    const rows = this.db
      .prepare(
        `SELECT * FROM realtime_events
          WHERE event_id > ?
            AND topic IN (${topics.map(() => '?').join(',')})
            AND (actor_id = ? OR topic = 'settings:self')
          ORDER BY event_id ASC
          LIMIT ?`
      )
      .all(input.afterEventId, ...topics, input.actorId, limit) as RealtimeEventRow[]

    return {
      events: rows.map((row) => this.toEnvelope(row)),
      latestEventId,
      gap: false
    }
  }

  deleteExpired(now = Date.now()): number {
    const result = this.db.prepare(`DELETE FROM realtime_events WHERE expires_at <= ?`).run(now)
    return result.changes
  }

  private toEnvelope(row: RealtimeEventRow): DurableRealtimeEnvelope {
    let payload: unknown = {}
    try {
      payload = JSON.parse(row.payload_json) as unknown
    } catch {
      payload = {}
    }
    return {
      eventId: row.event_id,
      ephemeral: false,
      topic: row.topic,
      type: row.event_type,
      entityId: row.entity_id,
      entityRevision: row.entity_revision,
      occurredAt: row.occurred_at,
      payload
    }
  }
}
