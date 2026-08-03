import type Database from 'better-sqlite3'
import type { ConversationMigration } from './conversation.ts'

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

function dropColumnIfPresent(db: Database.Database, table: string, column: string): void {
  if (!tableExists(db, table)) return
  if (!columnNames(db, table).has(column)) return
  db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)
}

/**
 * Drop historical wizard / create_task pointer columns (03 §14 / 06 residuals).
 * Completes the incomplete archive-only step from migration 050.
 *
 * Live CHECK tightening (chat-only thread_kind, text-only message kind, actor_id)
 * is migration 056.
 */
export const migration055DropWizardColumns: ConversationMigration = {
  version: 55,
  name: 'drop_wizard_columns',
  up(db) {
    // Pointer triggers reference columns we are about to drop.
    db.exec(`
      DROP TRIGGER IF EXISTS threads_active_draft_insert;
      DROP TRIGGER IF EXISTS threads_active_draft_update;
      DROP TRIGGER IF EXISTS thread_messages_clear_active_draft;
      DROP TRIGGER IF EXISTS threads_active_plan_insert;
      DROP TRIGGER IF EXISTS threads_active_plan_update;
      DROP TRIGGER IF EXISTS thread_jobs_clear_active_plan;
      DROP TRIGGER IF EXISTS design_sessions_clear_active_plan;
    `)

    if (tableExists(db, 'threads_legacy_archive')) {
      db.exec(`DROP TABLE threads_legacy_archive`)
    }

    dropColumnIfPresent(db, 'threads', 'wizard_phase')
    dropColumnIfPresent(db, 'threads', 'active_draft_id')
    dropColumnIfPresent(db, 'threads', 'active_plan_id')
    dropColumnIfPresent(db, 'thread_messages', 'wizard_phase')
  }
}
