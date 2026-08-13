import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { allMigrations, runMigrations } from '@codetask/database'
import {
  findManifestEntry,
  legacyMigrationChecksum
} from '../../packages/database/src/migrations/manifest'

test('runner rejects checksum, name, tombstone, and unknown-version drift', () => {
  const mutations: Array<(db: Database.Database) => void> = [
    (db) => db.prepare(`UPDATE schema_migrations SET checksum = 'bad' WHERE version = 1`).run(),
    (db) => db.prepare(`UPDATE schema_migrations SET name = 'renamed' WHERE version = 1`).run(),
    (db) =>
      db
        .prepare(
          `INSERT INTO schema_migrations(version, name, applied_at, checksum) VALUES (22, 'skipped_22', 0, 'bad')`
        )
        .run(),
    (db) =>
      db
        .prepare(
          `INSERT INTO schema_migrations(version, name, applied_at, checksum) VALUES (999, 'unknown', 0, 'bad')`
        )
        .run()
  ]

  for (const mutate of mutations) {
    const db = new Database(':memory:')
    runMigrations(db, allMigrations)
    mutate(db)
    assert.throws(() => runMigrations(db, allMigrations))
    db.close()
  }
})

test('legacy identity checksums upgrade to content-bound v2 checksums', () => {
  const db = new Database(':memory:')
  runMigrations(db, allMigrations)
  db.prepare(`UPDATE schema_migrations SET checksum = ? WHERE version = 1`).run(
    legacyMigrationChecksum(1, 'baseline_tables')
  )
  runMigrations(db, allMigrations)
  const row = db.prepare(`SELECT checksum FROM schema_migrations WHERE version = 1`).get() as {
    checksum: string
  }
  const manifest = findManifestEntry(1)
  assert.equal(manifest?.kind, 'migration')
  assert.equal(row.checksum, manifest?.kind === 'migration' ? manifest.checksum : '')
  assert.match(row.checksum, /^v2:/)
  db.close()
})

test('a migration that throws rolls back both schema changes and the version row', () => {
  const db = new Database(':memory:')
  const through67 = allMigrations.filter((migration) => migration.version <= 67)
  runMigrations(db, through67)
  const migration68 = allMigrations.find((migration) => migration.version === 68)
  assert.ok(migration68)

  assert.throws(() =>
    runMigrations(db, [
      ...through67,
      {
        ...migration68,
        up(database) {
          database.exec(`CREATE TABLE should_rollback(id INTEGER PRIMARY KEY)`)
          throw new Error('migration failed halfway')
        }
      }
    ])
  )
  assert.equal(
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'`)
      .get(),
    undefined
  )
  assert.equal(
    db.prepare(`SELECT version FROM schema_migrations WHERE version = 68`).get(),
    undefined
  )
  db.close()
})
