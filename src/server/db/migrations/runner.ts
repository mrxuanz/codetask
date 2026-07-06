import type Database from 'better-sqlite3'
import type { Migration } from './types'

export function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `)
}

export function currentMigrationVersion(db: Database.Database): number {
  const row = db.prepare(`SELECT MAX(version) AS version FROM schema_migrations`).get() as
    | { version: number | null }
    | undefined
  return row?.version ?? 0
}

export function runMigrations(db: Database.Database, migrations: Migration[]): void {
  ensureMigrationsTable(db)
  const applied = currentMigrationVersion(db)
  const pending = migrations
    .filter((m) => m.version > applied)
    .sort((a, b) => a.version - b.version)

  for (const migration of pending) {
    db.pragma('foreign_keys = OFF')
    try {
      const apply = db.transaction(() => {
        migration.up(db)
        db.prepare(
          `INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`
        ).run(migration.version, migration.name, Math.floor(Date.now() / 1000))
      })
      apply()
    } finally {
      db.pragma('foreign_keys = ON')
    }
  }
}
