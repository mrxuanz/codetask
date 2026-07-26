import type Database from 'better-sqlite3'
import { CORE_SCHEMA_VERSION, CORE_TABLE_STATEMENTS } from './schema/core-tables'

export type SqliteDatabase = Database.Database

/**
 * Apply new-core `core_*` tables onto an existing better-sqlite3 connection.
 * Safe to call repeatedly (IF NOT EXISTS). Does not touch legacy drizzle tables.
 */
export function applyCoreSchema(db: SqliteDatabase): void {
  db.pragma('foreign_keys = ON')
  const apply = db.transaction(() => {
    for (const statement of CORE_TABLE_STATEMENTS) {
      db.exec(statement)
    }
    db.prepare(
      `INSERT INTO core_schema_meta(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run('schema_version', String(CORE_SCHEMA_VERSION))
  })
  apply()
}

export function getCoreSchemaVersion(db: SqliteDatabase): number | null {
  const row = db
    .prepare(`SELECT value FROM core_schema_meta WHERE key = 'schema_version'`)
    .get() as { value: string } | undefined
  if (!row) return null
  const n = Number(row.value)
  return Number.isFinite(n) ? n : null
}
