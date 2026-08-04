import type Database from 'better-sqlite3'

export type AssetsMigration = {
  version: number
  name: string
  up: (db: Database.Database) => void
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name) as { name: string } | undefined
  return Boolean(row)
}

function columnNames(db: Database.Database, table: string): Set<string> {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(cols.map((c) => c.name))
}

/**
 * Batch G:
 * 1. Drop unwired conversation_outbox + agent_runtime_bindings
 *    (process-local RuntimeRegistry / Cursor registry remain authoritative).
 * 2. Introduce assets + asset_references.
 * 3. Backfill references from conversation_message_attachments.
 */
export const migration062AssetsAndDropDeadRuntimeTables: AssetsMigration = {
  version: 62,
  name: 'assets_and_drop_dead_runtime_tables',
  up(db) {
    if (tableExists(db, 'conversation_outbox')) {
      db.exec(`DROP TABLE conversation_outbox`)
    }
    if (tableExists(db, 'agent_runtime_bindings')) {
      db.exec(`DROP TABLE agent_runtime_bindings`)
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY NOT NULL,
        storage_key TEXT NOT NULL UNIQUE,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        delete_attempts INTEGER NOT NULL DEFAULT 0,
        last_delete_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_assets_state ON assets(state, updated_at);

      CREATE TABLE IF NOT EXISTS asset_references (
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        purpose TEXT NOT NULL DEFAULT 'attachment',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (asset_id, owner_type, owner_id, purpose)
      );
      CREATE INDEX IF NOT EXISTS idx_asset_references_owner
        ON asset_references(owner_type, owner_id);
    `)

    if (!tableExists(db, 'conversation_message_attachments')) return

    const now = Math.floor(Date.now() / 1000)
    const cols = columnNames(db, 'conversation_message_attachments')
    if (!cols.has('asset_id') || !cols.has('conversation_id')) return

    const rows = db
      .prepare(
        `SELECT id, conversation_id AS conversationId, asset_id AS assetId,
                size_bytes AS sizeBytes, name
           FROM conversation_message_attachments`
      )
      .all() as Array<{
      id: string
      conversationId: string
      assetId: string
      sizeBytes: number
      name: string
    }>

    const insertAsset = db.prepare(
      `INSERT OR IGNORE INTO assets
         (id, storage_key, size_bytes, sha256, created_at, updated_at, state, delete_attempts, last_delete_error)
       VALUES (?, ?, ?, NULL, ?, ?, 'active', 0, NULL)`
    )
    const insertRef = db.prepare(
      `INSERT OR IGNORE INTO asset_references
         (asset_id, owner_type, owner_id, purpose, created_at)
       VALUES (?, 'conversation', ?, 'attachment', ?)`
    )

    for (const row of rows) {
      const assetId = row.assetId?.trim() || row.id
      if (!assetId) continue
      const storageKey = `attachments/${row.conversationId}/${assetId}`
      insertAsset.run(assetId, storageKey, Number(row.sizeBytes) || 0, now, now)
      insertRef.run(assetId, row.conversationId, now)
    }
  }
}
