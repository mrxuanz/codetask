import type { Migration } from './types'

export const migration018DraftReferences: Migration = {
  version: 18,
  name: 'draft_references',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS draft_references (
        id TEXT PRIMARY KEY,
        design_session_id TEXT NOT NULL REFERENCES design_sessions(id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK (source IN ('attachment', 'local_corpus')),
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('file', 'directory', 'image')),
        description TEXT NOT NULL DEFAULT '',
        attachment_id TEXT,
        local_path TEXT,
        resolved_path TEXT,
        asset_url TEXT,
        mime_type TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_draft_references_session
        ON draft_references (design_session_id, sort_order);
    `)

    const cols = db.prepare(`PRAGMA table_info(design_sessions)`).all() as Array<{ name: string }>
    if (!cols.some((col) => col.name === 'manifest_revision')) {
      db.exec(`ALTER TABLE design_sessions ADD COLUMN manifest_revision INTEGER NOT NULL DEFAULT 0`)
    }
  }
}
