import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  KERNEL_SCHEMA_VERSION,
  openKernelDatabase,
  validateKernelDatabase
} from '../../../src/server/adapters/sqlite'

const EXPECTED_TABLES = [
  'auth_audit',
  'auth_challenges',
  'auth_sessions',
  'auth_throttles',
  'auth_users',
  'kernel_schema_migrations'
]

describe('kernel SQLite database', () => {
  it('creates the complete schema with foreign keys enabled', () => {
    const database = openKernelDatabase({ filename: ':memory:', nowMs: () => 42 })
    try {
      const tables = database.client
        .prepare(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
           ORDER BY name`
        )
        .all() as Array<{ name: string }>
      const migration = database.client
        .prepare(
          `SELECT version, applied_at_ms
           FROM kernel_schema_migrations
           ORDER BY version DESC
           LIMIT 1`
        )
        .get() as { version: number; applied_at_ms: number }

      assert.deepEqual(
        tables.map((row) => row.name),
        EXPECTED_TABLES
      )
      assert.equal(database.client.pragma('foreign_keys', { simple: true }), 1)
      assert.equal(migration.version, KERNEL_SCHEMA_VERSION)
      assert.equal(migration.applied_at_ms, 42)
    } finally {
      database.close()
    }
  })

  it('rejects orphan records', () => {
    const database = openKernelDatabase({ filename: ':memory:' })
    try {
      assert.throws(
        () =>
          database.client
            .prepare(
              `INSERT INTO auth_sessions
                 (id, user_id, token_digest, created_at_ms, last_seen_at_ms, expires_at_ms)
               VALUES ('session-1', 'missing', '${'a'.repeat(64)}', 1, 1, 2)`
            )
            .run(),
        /FOREIGN KEY/
      )
    } finally {
      database.close()
    }
  })

  it('reports integrity, foreign keys and bounded row counts', () => {
    const database = openKernelDatabase({ filename: ':memory:' })
    try {
      const report = validateKernelDatabase(database.client)

      assert.equal(report.ok, true)
      assert.equal(report.integrity, 'ok')
      assert.deepEqual(report.foreignKeyViolations, [])
      assert.equal(report.rowCounts.auth_users, 0)
      assert.equal(report.rowCounts.auth_sessions, 0)
    } finally {
      database.close()
    }
  })

  it('uses WAL and the configured busy timeout for file databases', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codetask-kernel-db-'))
    const database = openKernelDatabase({
      filename: join(directory, 'kernel.sqlite'),
      busyTimeoutMs: 7_500
    })
    try {
      assert.equal(database.client.pragma('journal_mode', { simple: true }), 'wal')
      assert.equal(database.client.pragma('busy_timeout', { simple: true }), 7_500)
    } finally {
      database.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('closes idempotently and rejects later transactions', () => {
    const database = openKernelDatabase({ filename: ':memory:' })
    database.close()
    database.close()

    assert.throws(() => database.transaction(() => undefined), /kernel_database\.closed/)
  })
})
