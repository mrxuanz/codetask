import assert from 'node:assert/strict'
import test from 'node:test'
import { allMigrations } from '../../src/server/db/migrations'
import { currentMigrationVersion, runMigrations } from '@codetask/database'
import { NodeSqliteAdapter } from '../helpers/node-sqlite-adapter'

test('the complete application migration chain runs on Node core SQLite', () => {
  const db = new NodeSqliteAdapter()
  try {
    runMigrations(db as never, allMigrations)
    assert.equal(currentMigrationVersion(db as never), allMigrations.at(-1)?.version)

    const tables = new Set(
      (
        db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
          name: string
        }>
      ).map((row) => row.name)
    )
    assert.equal(tables.has('projects'), true)
    assert.equal(tables.has('auth_users'), true)
    assert.equal(tables.has('auth_sessions'), true)
    assert.equal(tables.has('auth_secret'), true)
    assert.equal(tables.has('auth_state'), false)
    assert.equal(tables.has('auth_guard_state'), false)
  } finally {
    db.close()
  }
})
