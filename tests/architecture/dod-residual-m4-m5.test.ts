/**
 * Architecture residual DoD — M4 drop thread_jobs graph + M5 façade.
 * @see docs/架构收口/残差进度.md
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { allMigrations } from '../../src/server/db/migrations'
import { runMigrations } from '@codetask/database'

const root = join(import.meta.dirname, '../..')

const DROPPED = ['thread_jobs', 'draft_references'] as const
const RETAINED = ['job_artifacts', 'job_counters', 'design_plan_revisions'] as const

describe('architecture residual DoD — M4', () => {
  it('host schema no longer declares threadJobs / draftReferences', () => {
    const schema = readFileSync(join(root, 'src/server/db/schema.ts'), 'utf8')
    const index = readFileSync(join(root, 'src/server/db/index.ts'), 'utf8')
    assert.doesNotMatch(schema, /export const threadJobs\b/)
    assert.doesNotMatch(schema, /export const draftReferences\b/)
    assert.doesNotMatch(index, /\bthreadJobs\b/)
    assert.doesNotMatch(index, /\bdraftReferences\b/)
  })

  it('migration 060 drops thread_jobs graph and keeps retention tables', () => {
    const migration = readFileSync(
      join(root, 'packages/database/src/migrations/drop-thread-jobs-graph.ts'),
      'utf8'
    )
    assert.match(migration, /version:\s*60/)
    assert.match(migration, /DROP TABLE thread_jobs/)
    assert.match(migration, /DROP TABLE draft_references/)

    const index = readFileSync(join(root, 'packages/database/src/migrations/all.ts'), 'utf8')
    assert.match(index, /migration060DropThreadJobsGraph/)

    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, allMigrations)
    for (const table of DROPPED) {
      assert.equal(
        db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table),
        undefined,
        table
      )
    }
    for (const table of RETAINED) {
      assert.ok(
        db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table),
        table
      )
    }
    db.close()
  })
})

describe('architecture residual DoD — M5', () => {
  it('planning session mapper has no as-unknown cast', () => {
    const jobsApi = readFileSync(join(root, 'apps/web/src/api/jobs.ts'), 'utf8')
    assert.match(jobsApi, /function mapPlanningSessionToJob/)
    assert.doesNotMatch(jobsApi, /as unknown as PlanningSessionViewDto/)
    assert.match(jobsApi, /mapExecutionJobToPlanView/)
  })

  it('threads façade is deleted; conversation client owns list helpers', () => {
    assert.equal(existsSync(join(root, 'apps/web/src/api/threads.ts')), false)
    const conversation = readFileSync(join(root, 'apps/web/src/api/conversation.ts'), 'utf8')
    assert.match(conversation, /listConversationItems|conversationToListItem/)
  })

  it('JobAbilityDto is the canonical ability type', () => {
    const jobs = readFileSync(join(root, 'packages/contracts/src/ui-jobs.ts'), 'utf8')
    assert.match(jobs, /export type JobAbilityDto/)
    assert.match(jobs, /export type ThreadJobAbilityDto = JobAbilityDto/)
    const planning = readFileSync(join(root, 'packages/contracts/src/ui-planning.ts'), 'utf8')
    assert.match(planning, /abilities: JobAbilityDto\[\]/)
    assert.match(planning, /export function toPlanningSessionStatus/)
  })

  it('draft plan workspace uses mapExecutionJobToPlanView', () => {
    const ws = readFileSync(join(root, 'apps/web/src/composables/useDraftPlanWorkspace.ts'), 'utf8')
    assert.match(ws, /mapExecutionJobToPlanView/)
    assert.doesNotMatch(ws, /as unknown as PlanningSessionViewDto/)
  })
})
