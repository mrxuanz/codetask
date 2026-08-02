import type Database from 'better-sqlite3'
import type { ConversationMigration } from './conversation.ts'

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name) as { name: string } | undefined
  return Boolean(row)
}

/**
 * Drop archived turn table and snapshot legacy threads (03 §20).
 * Column drops completed in migration 055 (`drop_wizard_columns`).
 */
export const migration050ConversationCleanup: ConversationMigration = {
  version: 50,
  name: 'conversation_cleanup',
  up(db) {
    if (tableExists(db, 'conversation_turns_legacy')) {
      db.exec(`DROP TABLE conversation_turns_legacy`)
    }

    // Snapshot for one-release audit; migration 055 drops this archive and wizard columns.
    if (tableExists(db, 'threads')) {
      const cols = db.prepare(`PRAGMA table_info(threads)`).all() as Array<{ name: string }>
      const names = new Set(cols.map((c) => c.name))
      if (names.has('wizard_phase') || names.has('thread_kind') || names.has('active_draft_id')) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS threads_legacy_archive AS SELECT * FROM threads WHERE 0;
          DELETE FROM threads_legacy_archive;
          INSERT INTO threads_legacy_archive SELECT * FROM threads;
        `)
      }
    }
  }
}
