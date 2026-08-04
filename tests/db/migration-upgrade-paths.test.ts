import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { allMigrations } from '../../src/server/db/migrations'
import { currentMigrationVersion, runMigrations } from '../../src/server/db/migrations/runner'
import {
  runMigrationsUpTo,
  schemaFingerprint,
  seedMinimalProjectThreadAtV42
} from '../helpers/migration-fixture'

const latestMigrationVersion = allMigrations.at(-1)?.version
if (latestMigrationVersion === undefined) {
  throw new Error('Expected at least one database migration')
}

test('fresh → latest applies all migrations with empty FK check', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db, allMigrations)

  const fp = schemaFingerprint(db)
  assert.equal(fp.schemaVersion, latestMigrationVersion)
  assert.deepEqual(fp.foreignKeyViolations, [])
  assert.ok(fp.tables.some((t) => t.name === 'projects'))
  assert.ok(fp.tables.some((t) => t.name === 'conversation_threads'))
  db.close()
})

test('v42 → latest upgrades seeded project/thread with empty FK check', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')

  runMigrationsUpTo(db, allMigrations, 42)
  assert.equal(currentMigrationVersion(db), 42)
  seedMinimalProjectThreadAtV42(db)

  const mid = schemaFingerprint(db)
  assert.equal(mid.schemaVersion, 42)
  assert.ok(mid.tables.some((t) => t.name === 'projects'))

  runMigrations(db, allMigrations)
  const fp = schemaFingerprint(db)
  assert.equal(fp.schemaVersion, latestMigrationVersion)
  assert.deepEqual(fp.foreignKeyViolations, [])

  const project = db.prepare(`SELECT id FROM projects WHERE id = ?`).get('proj-v42') as
    | { id: string }
    | undefined
  assert.equal(project?.id, 'proj-v42')

  assert.equal(
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='threads'`).get(),
    undefined
  )
  assert.equal(
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_messages'`).get(),
    undefined
  )
  db.close()
})

test('v60 → latest is idempotent (or upgrades when newer migrations exist)', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')

  runMigrationsUpTo(db, allMigrations, 60)
  assert.equal(currentMigrationVersion(db), Math.min(60, latestMigrationVersion))

  const before = schemaFingerprint(db)
  runMigrations(db, allMigrations)
  const after = schemaFingerprint(db)

  assert.equal(after.schemaVersion, latestMigrationVersion)
  assert.deepEqual(after.foreignKeyViolations, [])
  assert.equal(before.schemaVersion, Math.min(60, latestMigrationVersion))
  if (before.schemaVersion === after.schemaVersion) {
    assert.deepEqual(
      before.tables.map((t) => t.name),
      after.tables.map((t) => t.name)
    )
  }
  db.close()
})
