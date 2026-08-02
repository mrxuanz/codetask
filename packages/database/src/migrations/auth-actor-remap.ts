import type Database from 'better-sqlite3'

export type AuthMigration = {
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

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return cols.some((c) => c.name === column)
}

/**
 * Remap business actor_id values from username → auth_users.id (04 Actor cutover).
 * Revokes all sessions so clients re-login with the stable Actor identity.
 */
export const migration051ActorIdRemap: AuthMigration = {
  version: 51,
  name: 'actor_id_username_to_user_id',
  up(db) {
    if (!tableExists(db, 'auth_users')) return

    const user = db
      .prepare(`SELECT id, username FROM auth_users WHERE singleton_key = 1 LIMIT 1`)
      .get() as { id: string; username: string } | undefined

    if (!user) {
      // No account yet — still clear any stray sessions.
      if (tableExists(db, 'auth_sessions')) {
        db.exec(`DELETE FROM auth_sessions`)
      }
      return
    }

    const tables = [
      'drafts',
      'planning_sessions',
      'jobs',
      'job_submission_dedup',
      'conversation_threads',
      'conversation_turns',
      'conversation_messages'
    ] as const

    db.transaction(() => {
      for (const table of tables) {
        if (!tableExists(db, table) || !columnExists(db, table, 'actor_id')) continue
        db.prepare(
          `UPDATE ${table} SET actor_id = ? WHERE actor_id = ? OR actor_id = ?`
        ).run(user.id, user.username, user.id)
      }

      // Legacy threads table used username as owner.
      if (tableExists(db, 'threads') && columnExists(db, 'threads', 'username')) {
        // keep username column as display username; no remap required
      }

      if (tableExists(db, 'auth_sessions')) {
        db.exec(`UPDATE auth_sessions SET revoked_at_ms = strftime('%s','now') * 1000,
          revoke_reason = 'actor_cutover' WHERE revoked_at_ms IS NULL`)
      }
    })()
  }
}
