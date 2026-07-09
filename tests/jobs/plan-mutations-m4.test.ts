import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { applyMigrations } from '../../src/server/db/migrations'
import {
  clearPlanConfirmedFlags,
  isPlanFullyConfirmed,
  buildPlanSummary
} from '../../src/shared/plan-mutations'
import type { SavedJobPlan } from '../../src/shared/contracts/plan'
import { AppError } from '../../src/server/error'

function samplePlan(confirmed = true): SavedJobPlan {
  return {
    milestones: [
      {
        title: 'M1',
        successCriteria: 'm done',
        confirmed,
        slices: [
          {
            title: 'S1',
            successCriteria: 's done',
            confirmed,
            tasks: [
              {
                title: 'T1',
                description: 'd',
                taskKind: 'general-implementation',
                abilityCode: 'general-implementation',
                confirmed
              }
            ]
          }
        ]
      }
    ],
    tasks: [
      {
        id: 'm1-s1-t1',
        milestoneIndex: 1,
        sliceIndex: 1,
        taskIndex: 1,
        title: 'T1',
        description: 'd',
        taskKind: 'general-implementation',
        abilityCode: 'general-implementation',
        contextMarkdown: 'ctx',
        successCriteria: 'done',
        confirmed
      }
    ]
  }
}

test('migration 019 adds design plan artifact columns', () => {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  applyMigrations(sqlite)

  // After P10 (026), plan artifact columns live on thread_jobs.
  const cols = sqlite.prepare(`PRAGMA table_info(thread_jobs)`).all() as Array<{ name: string }>
  const names = new Set(cols.map((col) => col.name))
  assert.ok(names.has('plan_artifact_id'))
  assert.ok(names.has('plan_summary_json'))
  assert.ok(names.has('plan_artifact_path'))
  sqlite.close()
})

test('clearPlanConfirmedFlags resets all confirmed fields', () => {
  const cleared = clearPlanConfirmedFlags(samplePlan(true))
  assert.equal(cleared.milestones[0]?.confirmed, undefined)
  assert.equal(cleared.milestones[0]?.slices[0]?.confirmed, undefined)
  assert.equal(cleared.milestones[0]?.slices[0]?.tasks[0]?.confirmed, undefined)
  assert.equal(cleared.tasks[0]?.confirmed, undefined)
})

test('isPlanFullyConfirmed requires every node confirmed', () => {
  assert.equal(isPlanFullyConfirmed(samplePlan(true)), true)
  assert.equal(isPlanFullyConfirmed(samplePlan(false)), false)
  assert.equal(isPlanFullyConfirmed({ milestones: [], tasks: [] }), false)
})

test('buildPlanSummary counts milestones slices tasks', () => {
  assert.deepEqual(buildPlanSummary(samplePlan()), { milestones: 1, slices: 1, tasks: 1 })
})

test('AppError.conflict maps to HTTP 409', () => {
  const err = AppError.conflict('revision mismatch', { currentPlanRevision: 2 })
  assert.equal(err.httpStatus, 409)
  assert.equal(err.status, 40901)
})
