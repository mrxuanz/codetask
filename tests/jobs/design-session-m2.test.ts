import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { isDesignSessionId, DESIGN_SESSION_ID_PREFIX } from '../../src/shared/design-session'
import { applyMigrations } from '../../src/server/db/migrations'

test('isDesignSessionId recognizes ds- prefix', () => {
  assert.equal(isDesignSessionId(`${DESIGN_SESSION_ID_PREFIX}abc`), true)
  assert.equal(isDesignSessionId('job-abc'), false)
  assert.equal(isDesignSessionId(null), false)
})

test('migration 016 creates design_sessions and design_runs tables', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'm2-migration-'))
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  applyMigrations(sqlite)

  const tables = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .all() as Array<{ name: string }>
  const names = new Set(tables.map((t) => t.name))
  assert.ok(names.has('design_sessions'))
  assert.ok(names.has('design_runs'))
  assert.ok(names.has('design_plan_tasks'))
  assert.ok(names.has('design_abilities'))

  sqlite.close()
  rmSync(dataDir, { recursive: true, force: true })
})
