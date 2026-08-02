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
 * Rename projects.username → actor_id and remap username → auth_users.id (04 DoD §5).
 */
export const migration052ProjectsActorId: AuthMigration = {
  version: 52,
  name: 'projects_username_to_actor_id',
  up(db) {
    if (!tableExists(db, 'projects')) return
    if (columnExists(db, 'projects', 'actor_id') && !columnExists(db, 'projects', 'username')) {
      return
    }

    const user = tableExists(db, 'auth_users')
      ? (db
          .prepare(`SELECT id, username FROM auth_users WHERE singleton_key = 1 LIMIT 1`)
          .get() as { id: string; username: string } | undefined)
      : undefined

    db.pragma('foreign_keys = OFF')
    db.transaction(() => {
      db.exec(`
        CREATE TABLE projects_actor (
          id TEXT PRIMARY KEY NOT NULL,
          actor_id TEXT NOT NULL,
          title TEXT NOT NULL,
          workspace_root TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX idx_projects_actor_workspace
          ON projects_actor(actor_id, workspace_root);
      `)

      if (columnExists(db, 'projects', 'username')) {
        const rows = db
          .prepare(
            `SELECT id, username, title, workspace_root, created_at, updated_at FROM projects`
          )
          .all() as Array<{
          id: string
          username: string
          title: string
          workspace_root: string
          created_at: number
          updated_at: number
        }>
        const insert = db.prepare(
          `INSERT INTO projects_actor (id, actor_id, title, workspace_root, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        for (const row of rows) {
          let actorId = row.username
          if (user && (row.username === user.username || row.username === user.id)) {
            actorId = user.id
          }
          insert.run(
            row.id,
            actorId,
            row.title,
            row.workspace_root,
            row.created_at,
            row.updated_at
          )
        }
      } else if (columnExists(db, 'projects', 'actor_id')) {
        db.exec(`
          INSERT INTO projects_actor (id, actor_id, title, workspace_root, created_at, updated_at)
          SELECT id, actor_id, title, workspace_root, created_at, updated_at FROM projects
        `)
      }

      db.exec(`DROP TABLE projects`)
      db.exec(`ALTER TABLE projects_actor RENAME TO projects`)
    })()
    db.pragma('foreign_keys = ON')
  }
}
