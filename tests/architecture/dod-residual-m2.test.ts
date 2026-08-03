/**
 * Architecture residual DoD — M2 legacy job shell tables.
 * @see docs/架构收口/残差进度.md
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { allMigrations } from '../../src/server/db/migrations'
import { runMigrations } from '../../src/server/db/migrations/runner'

const root = join(import.meta.dirname, '../..')

const DROPPED_SHELL_TABLES = [
  'job_task_attempts',
  'workload_slots',
  'workload_runs',
  'job_tasks',
  'job_abilities',
  'job_plan_tasks',
  'job_plan_slices',
  'job_plan_milestones',
  'design_runs'
] as const

describe('architecture residual DoD — M2', () => {
  it('host schema no longer declares dropped shell tables', () => {
    const schema = readFileSync(join(root, 'src/server/db/schema.ts'), 'utf8')
    const index = readFileSync(join(root, 'src/server/db/index.ts'), 'utf8')
    for (const name of [
      'jobTasks',
      'jobTaskAttempts',
      'jobAbilities',
      'jobPlanTasks',
      'jobPlanMilestones',
      'jobPlanSlices',
      'designRuns',
      'workloadRuns',
      'workloadSlots'
    ]) {
      assert.doesNotMatch(schema, new RegExp(`export const ${name}\\b`))
      assert.doesNotMatch(index, new RegExp(`\\b${name}\\b`))
    }
  })

  it('migration 059 drops shell tables on empty DB', () => {
    const migration = readFileSync(
      join(root, 'packages/database/src/migrations/drop-legacy-job-shell-tables.ts'),
      'utf8'
    )
    assert.match(migration, /version:\s*59/)
    for (const table of DROPPED_SHELL_TABLES) {
      assert.match(migration, new RegExp(`'${table}'`))
    }

    const index = readFileSync(join(root, 'src/server/db/migrations/index.ts'), 'utf8')
    assert.match(index, /migration059DropLegacyJobShellTablesHost/)

    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, allMigrations)
    for (const table of DROPPED_SHELL_TABLES) {
      assert.equal(
        db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table),
        undefined,
        `expected ${table} absent`
      )
    }
    db.close()
  })
})
