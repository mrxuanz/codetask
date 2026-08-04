import type Database from 'better-sqlite3'
import {
  assertManifestContiguous,
  findManifestEntry,
  listManifestMigrations,
  migrationChecksum,
  type MigrationManifestEntry
} from '../../../../packages/database/src/migrations/manifest.ts'
import type { Migration } from './types'

export function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      checksum TEXT
    );
  `)
  const cols = db.prepare(`PRAGMA table_info(schema_migrations)`).all() as Array<{ name: string }>
  if (!cols.some((col) => col.name === 'checksum')) {
    db.exec(`ALTER TABLE schema_migrations ADD COLUMN checksum TEXT`)
  }
}

export function currentMigrationVersion(db: Database.Database): number {
  const row = db.prepare(`SELECT MAX(version) AS version FROM schema_migrations`).get() as
    | { version: number | null }
    | undefined
  return row?.version ?? 0
}

function readApplied(db: Database.Database): Array<{
  version: number
  name: string
  checksum: string | null
}> {
  return db
    .prepare(`SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC`)
    .all() as Array<{ version: number; name: string; checksum: string | null }>
}

function backfillMissingChecksums(db: Database.Database): void {
  const rows = readApplied(db)
  const update = db.prepare(`UPDATE schema_migrations SET checksum = ? WHERE version = ?`)
  for (const row of rows) {
    if (row.checksum) continue
    const entry = findManifestEntry(row.version)
    if (!entry || entry.kind !== 'migration') {
      // Legacy DB may have a name that still hashes stably from stored name.
      update.run(migrationChecksum(row.version, row.name), row.version)
      continue
    }
    if (entry.name !== row.name) {
      throw new Error(
        `schema_migrations name mismatch at v${row.version}: db=${row.name} manifest=${entry.name}`
      )
    }
    update.run(entry.checksum, row.version)
  }
}

function assertAppliedMatchManifest(db: Database.Database): void {
  assertManifestContiguous()
  const applied = readApplied(db)
  for (const row of applied) {
    const entry = findManifestEntry(row.version)
    if (!entry) {
      throw new Error(`Applied migration v${row.version} (${row.name}) is not in manifest`)
    }
    if (entry.kind === 'tombstone') {
      throw new Error(`Tombstone version ${row.version} must not appear in schema_migrations`)
    }
    if (entry.name !== row.name) {
      throw new Error(
        `Migration name drift at v${row.version}: db=${row.name} manifest=${entry.name}`
      )
    }
    const expected = row.checksum ?? entry.checksum
    if (expected !== entry.checksum) {
      throw new Error(
        `Migration checksum mismatch at v${row.version} (${row.name}): expected ${entry.checksum}, got ${expected}`
      )
    }
  }
}

export function assertMigrationsAlignWithManifest(migrations: Migration[]): void {
  assertManifestContiguous()
  const byVersion = new Map(migrations.map((m) => [m.version, m]))
  for (const migration of migrations) {
    const entry = findManifestEntry(migration.version)
    if (!entry || entry.kind !== 'migration') {
      throw new Error(`Runner migration v${migration.version} not present as manifest migration`)
    }
    if (migration.name !== entry.name) {
      throw new Error(
        `Migration name mismatch at v${migration.version}: code=${migration.name} manifest=${entry.name}`
      )
    }
    const checksum = migrationChecksum(migration.version, migration.name)
    if (checksum !== entry.checksum) {
      throw new Error(`Checksum mismatch for v${migration.version} (${migration.name})`)
    }
  }

  // When the full runner list is provided, every non-tombstone manifest entry must exist.
  const maxProvided = migrations.reduce((max, item) => Math.max(max, item.version), 0)
  const latestManifest = listManifestMigrations().at(-1)?.version ?? 0
  if (maxProvided >= latestManifest && migrations.length === listManifestMigrations().length) {
    for (const entry of listManifestMigrations()) {
      if (!byVersion.has(entry.version)) {
        throw new Error(
          `Manifest migration v${entry.version} (${entry.name}) missing from runner list`
        )
      }
    }
  }
}

export function runMigrations(db: Database.Database, migrations: Migration[]): void {
  ensureMigrationsTable(db)
  assertMigrationsAlignWithManifest(migrations)
  backfillMissingChecksums(db)
  assertAppliedMatchManifest(db)

  const applied = currentMigrationVersion(db)
  const pending = migrations
    .filter((m) => m.version > applied)
    .sort((a, b) => a.version - b.version)

  for (const migration of pending) {
    const entry = findManifestEntry(migration.version) as
      | Extract<MigrationManifestEntry, { kind: 'migration' }>
      | undefined
    if (!entry || entry.kind !== 'migration') {
      throw new Error(`Refusing to apply unmanifested migration v${migration.version}`)
    }
    if (entry.name !== migration.name) {
      throw new Error(
        `Refusing to apply migration name drift at v${migration.version}: ${migration.name}`
      )
    }

    db.pragma('foreign_keys = OFF')
    try {
      const apply = db.transaction(() => {
        migration.up(db)
        db.prepare(
          `INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)`
        ).run(migration.version, migration.name, Math.floor(Date.now() / 1000), entry.checksum)
      })
      apply()
    } finally {
      db.pragma('foreign_keys = ON')
    }
  }

  if (pending.length > 0) {
    // Post-upgrade integrity probe — fail the upgrade path if FK graph is broken.
    const fk = db.prepare(`PRAGMA foreign_key_check`).all()
    if (fk.length > 0) {
      throw new Error(
        `foreign_key_check failed after migrations: ${JSON.stringify(fk.slice(0, 5))}`
      )
    }
  }
}
