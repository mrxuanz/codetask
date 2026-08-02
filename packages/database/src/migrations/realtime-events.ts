import type Database from 'better-sqlite3'

export type AuthMigration = {
  version: number
  name: string
  up: (db: Database.Database) => void
}

/**
 * Durable browser realtime event log (06 §23.1).
 * Ephemeral deltas (thinking/text) never land here.
 */
export const migration054RealtimeEvents: AuthMigration = {
  version: 54,
  name: 'realtime_events',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS realtime_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id TEXT NOT NULL,
        source_module TEXT NOT NULL,
        source_outbox_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        event_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        entity_revision INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_realtime_events_source
        ON realtime_events(source_module, source_outbox_id);

      CREATE INDEX IF NOT EXISTS idx_realtime_events_actor_id
        ON realtime_events(actor_id, event_id);

      CREATE INDEX IF NOT EXISTS idx_realtime_events_topic_id
        ON realtime_events(topic, event_id);

      CREATE INDEX IF NOT EXISTS idx_realtime_events_expires
        ON realtime_events(expires_at);
    `)
  }
}
