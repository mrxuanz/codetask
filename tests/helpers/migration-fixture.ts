import type Database from 'better-sqlite3'
import type { Migration } from '../../src/server/db/migrations/types'
import { currentMigrationVersion, runMigrations } from '../../src/server/db/migrations/runner'

export function runMigrationsUpTo(
  db: Database.Database,
  migrations: Migration[],
  maxVersion: number
): void {
  runMigrations(
    db,
    migrations.filter((m) => m.version <= maxVersion)
  )
}

export type SchemaFingerprint = {
  schemaVersion: number
  tables: Array<{ name: string; columns: string[] }>
  foreignKeyViolations: unknown[]
}

export function schemaFingerprint(db: Database.Database): SchemaFingerprint {
  const tables = (
    db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`
      )
      .all() as Array<{ name: string }>
  ).map((row) => {
    const columns = (
      db.prepare(`PRAGMA table_info(${quoteIdent(row.name)})`).all() as Array<{ name: string }>
    ).map((c) => c.name)
    return { name: row.name, columns }
  })

  const foreignKeyViolations = db.prepare(`PRAGMA foreign_key_check`).all()

  return {
    schemaVersion: currentMigrationVersion(db),
    tables,
    foreignKeyViolations
  }
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe table name for PRAGMA: ${name}`)
  }
  return name
}

/** Minimal project + thread seed valid at migration ≤42 (username owner columns). */
export function seedMinimalProjectThreadAtV42(db: Database.Database): void {
  const now = Math.floor(Date.now() / 1000)
  const projectCols = db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>
  const ownerCol = projectCols.some((c) => c.name === 'actor_id') ? 'actor_id' : 'username'

  db.prepare(
    `INSERT INTO projects (id, ${ownerCol}, title, workspace_root, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run('proj-v42', 'alice', 'V42 Fixture', '/tmp/v42', now, now)

  const threadCols = new Set(
    (db.prepare(`PRAGMA table_info(threads)`).all() as Array<{ name: string }>).map((c) => c.name)
  )
  const threadOwner = threadCols.has('actor_id') ? 'actor_id' : 'username'

  const columns = [
    'id',
    threadOwner,
    'project_id',
    'title',
    'status',
    'conversation_id',
    'core_code',
    'runtime_status',
    'created_at',
    'updated_at'
  ]
  const values: unknown[] = [
    'thread-v42',
    'alice',
    'proj-v42',
    'Thread V42',
    'draft',
    'conv-v42',
    'codex',
    'idle',
    now,
    now
  ]

  if (threadCols.has('title_source')) {
    columns.push('title_source')
    values.push('auto')
  }
  if (threadCols.has('thread_kind')) {
    columns.push('thread_kind')
    values.push('chat')
  }
  if (threadCols.has('core_runtime_json')) {
    columns.push('core_runtime_json')
    values.push('{}')
  }

  db.prepare(
    `INSERT INTO threads (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
  ).run(...values)
}
