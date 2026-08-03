import type Database from 'better-sqlite3'
import type { ConversationMigration } from './conversation.ts'

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name) as { name: string } | undefined
  return Boolean(row)
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return cols.some((c) => c.name === column)
}

function remapOwnerColumn(db: Database.Database, table: string): void {
  if (!tableExists(db, table)) return
  if (columnExists(db, table, 'actor_id') && !columnExists(db, table, 'username')) return
  if (!columnExists(db, table, 'username')) return

  // SQLite 3.25+: rename in place, then remap values to auth_users.id.
  db.exec(`ALTER TABLE ${table} RENAME COLUMN username TO actor_id`)

  if (!tableExists(db, 'auth_users')) return
  const user = db
    .prepare(`SELECT id, username FROM auth_users WHERE singleton_key = 1 LIMIT 1`)
    .get() as { id: string; username: string } | undefined
  if (!user) return

  db.prepare(`UPDATE ${table} SET actor_id = ? WHERE actor_id = ? OR actor_id = ?`).run(
    user.id,
    user.username,
    user.id
  )
}

/**
 * Rename legacy owner columns on thread_messages / thread_jobs to actor_id (04 Actor).
 * Completes the threads.username → actor_id cutover from migration 056.
 */
export const migration057LegacyOwnerActorId: ConversationMigration = {
  version: 57,
  name: 'legacy_owner_actor_id',
  up(db) {
    remapOwnerColumn(db, 'thread_messages')
    remapOwnerColumn(db, 'thread_jobs')
  }
}
