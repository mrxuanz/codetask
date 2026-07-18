import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { runMigrations } from '../../../src/server/db/migrations/runner'
import { allMigrations } from '../../../src/server/db/migrations/index'
import { controlPlaneSchema } from '../../../src/server/infra/sqlite/control-plane/schema'
import { createControlPlaneTransaction } from '../../../src/server/infra/sqlite/control-plane/sqlite-control-plane-unit-of-work'
import { seedOwnedThreadJob } from '../fixtures/seed-owned-thread-job'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db, allMigrations)
  return db
}

function seedMilestonePlan(db: Database.Database): void {
  const now = Date.now()
  seedOwnedThreadJob(db, { jobId: 'job-1', username: 'u1', status: 'pending' })
  db.prepare(
    `INSERT INTO control_jobs (
      id, thread_id, project_id, draft_message_id, state, state_revision,
      control_intent, resume_target, current_plan_revision, execution_generation,
      active_run_id, title, requirements_summary, created_at_ms, updated_at_ms
    ) VALUES ('job-1', 'thread-job-1', 'project-job-1', 'draft-job-1', 'execution_running', 1,
      'none', NULL, 1, 0, NULL, 'Test', '', ?, ?)`
  ).run(now, now)
  db.prepare(
    `INSERT INTO control_plan_revisions (id, job_id, plan_revision, status, content_hash, created_at_ms)
     VALUES ('plan-1', 'job-1', 1, 'confirmed', 'hash-1', ?)`
  ).run(now)
  db.prepare(
    `INSERT INTO control_plan_milestones (
      id, job_id, plan_revision, milestone_id, title, sort_order, created_at_ms
    ) VALUES ('m-row-1', 'job-1', 1, 'm1', 'Milestone 1', 0, ?)`
  ).run(now)
  db.prepare(
    `INSERT INTO control_plan_slices (
      id, job_id, plan_revision, milestone_id, slice_id, title, sort_order, created_at_ms
    ) VALUES ('s-row-1', 'job-1', 1, 'm1', 'slice-1', 'Slice 1', 0, ?),
             ('s-row-2', 'job-1', 1, 'm1', 'slice-2', 'Slice 2', 1, ?)`
  ).run(now, now)
}

describe('milestone readiness (CR5)', () => {
  let rawDb: Database.Database
  let verifications: ReturnType<typeof createControlPlaneTransaction>['verifications']

  beforeEach(() => {
    rawDb = createTestDb()
    seedMilestonePlan(rawDb)
    const drizzleDb = drizzle(rawDb, { schema: controlPlaneSchema })
    verifications = createControlPlaneTransaction(drizzleDb).verifications
  })

  it('is not ready when any required slice lacks a passed verdict', () => {
    assert.equal(verifications.isMilestoneReady('job-1', 0, 1, 'm1'), false)

    const now = Date.now()
    rawDb.prepare(
      `INSERT INTO control_evidence_blobs (hash, content_json, bytes, created_at_ms)
       VALUES ('vh-1', '{}', 2, ?), ('rh-1', '{}', 2, ?)`
    ).run(now, now)
    rawDb.prepare(
      `INSERT INTO control_verifications (
        id, job_id, execution_generation, plan_revision, scope_type, scope_id,
        attempt_no, state, verdict_blob_hash, result_hash, result_revision, started_at_ms, ended_at_ms
      ) VALUES ('v-1', 'job-1', 0, 1, 'slice', 'slice-1', 1, 'passed', 'vh-1', 'rh-1', 2, ?, ?)`
    ).run(now, now)

    assert.equal(verifications.isMilestoneReady('job-1', 0, 1, 'm1'), false)
  })

  it('is ready only after every slice in the milestone has a passed verdict', () => {
    const now = Date.now()
    rawDb.prepare(
      `INSERT INTO control_evidence_blobs (hash, content_json, bytes, created_at_ms)
       VALUES ('vh-1', '{}', 2, ?), ('vh-2', '{}', 2, ?), ('rh-1', '{}', 2, ?), ('rh-2', '{}', 2, ?)`
    ).run(now, now, now, now)
    rawDb.prepare(
      `INSERT INTO control_verifications (
        id, job_id, execution_generation, plan_revision, scope_type, scope_id,
        attempt_no, state, verdict_blob_hash, result_hash, result_revision, started_at_ms, ended_at_ms
      ) VALUES
        ('v-1', 'job-1', 0, 1, 'slice', 'slice-1', 1, 'passed', 'vh-1', 'rh-1', 2, ?, ?),
        ('v-2', 'job-1', 0, 1, 'slice', 'slice-2', 1, 'passed', 'vh-2', 'rh-2', 3, ?, ?)`
    ).run(now, now, now, now)

    assert.equal(verifications.isMilestoneReady('job-1', 0, 1, 'm1'), true)
  })
})
