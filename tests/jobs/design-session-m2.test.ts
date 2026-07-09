import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import Database from 'better-sqlite3'
import {
  isDesignSessionId,
  isPlanningJobStatus,
  isPlanningWorkspaceStatus,
  DESIGN_SESSION_ID_PREFIX
} from '../../src/shared/design-session'
import { allMigrations } from '../../src/server/db/migrations'
import { runMigrations } from '../../src/server/db/migrations/runner'

test('isDesignSessionId recognizes ds- prefix', () => {
  assert.equal(isDesignSessionId(`${DESIGN_SESSION_ID_PREFIX}abc`), true)
  assert.equal(isDesignSessionId('job-abc'), false)
  assert.equal(isDesignSessionId(null), false)
})

test('isPlanningJobStatus recognizes active planning statuses', () => {
  assert.equal(isPlanningJobStatus('planning'), true)
  assert.equal(isPlanningJobStatus('plan_editing'), true)
  assert.equal(isPlanningJobStatus('pending'), false)
  assert.equal(isPlanningJobStatus('running'), false)
  assert.equal(isPlanningJobStatus('cancelled'), false)
  assert.equal(isPlanningJobStatus(null), false)
})

test('isPlanningWorkspaceStatus includes terminal planning workspace statuses', () => {
  assert.equal(isPlanningWorkspaceStatus('planning'), true)
  assert.equal(isPlanningWorkspaceStatus('plan_editing'), true)
  assert.equal(isPlanningWorkspaceStatus('cancelled'), true)
  assert.equal(isPlanningWorkspaceStatus('failed'), true)
  assert.equal(isPlanningWorkspaceStatus('pending'), false)
  assert.equal(isPlanningWorkspaceStatus(undefined), false)
})

test('migration 016 creates design_sessions and design_runs tables', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'm2-migration-'))
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  const through16 = allMigrations.filter((m) => m.version <= 16)
  runMigrations(sqlite, through16)

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
