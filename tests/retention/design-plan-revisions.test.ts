import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { and, eq } from 'drizzle-orm'
import { closeIsolatedTestDatabase, createIsolatedTestDatabase } from '../../src/server/db'
import { designPlanRevisions, threadJobs } from '../../src/server/db/schema'
import {
  DesignPlanRevisionConflictError,
  deleteExpiredDesignPlanRevisions,
  finalizeDesignPlanRevisions,
  putDesignPlanRevisionInTx,
  readDesignPlanRevision
} from '../../src/server/retention/design-plan-artifacts'
import { seedMinimalJob } from '../helpers/seed-minimal-job'
import type { SavedJobPlan } from '../../src/server/planner/plan-types'

function plan(revision: number): SavedJobPlan {
  return {
    milestones: [
      {
        title: `Milestone ${revision}`,
        successCriteria: 'done',
        slices: [
          {
            title: 'Slice',
            successCriteria: 'done',
            tasks: [
              { title: `Task ${revision}`, description: 'work', taskKind: 'general-implementation' }
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
        title: `Task ${revision}`,
        description: 'work',
        taskKind: 'general-implementation',
        abilityCode: 'general-implementation',
        contextMarkdown: '',
        successCriteria: 'done'
      }
    ]
  }
}

test('design plan revisions use gzip BLOB, are idempotent, and retain only the newest three', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-design-revisions-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const db = createIsolatedTestDatabase(dataDir)
  t.after(() => closeIsolatedTestDatabase(db))
  await seedMinimalJob(db, 'job-design-revisions', 'plan_editing')

  for (let revision = 1; revision <= 4; revision += 1) {
    db.transaction((tx) =>
      putDesignPlanRevisionInTx(tx, {
        jobId: 'job-design-revisions',
        planRevision: revision,
        plan: plan(revision)
      })
    )
  }

  const rows = await db
    .select()
    .from(designPlanRevisions)
    .where(eq(designPlanRevisions.jobId, 'job-design-revisions'))
  assert.deepEqual(rows.map((row) => row.planRevision).sort(), [2, 3, 4])
  assert.ok(Buffer.isBuffer(rows[0]?.contentGzip))
  assert.equal(readDesignPlanRevision(db, 'job-design-revisions', 4)?.tasks[0]?.title, 'Task 4')

  assert.doesNotThrow(() =>
    db.transaction((tx) =>
      putDesignPlanRevisionInTx(tx, {
        jobId: 'job-design-revisions',
        planRevision: 4,
        plan: plan(4)
      })
    )
  )
  assert.throws(
    () =>
      db.transaction((tx) =>
        putDesignPlanRevisionInTx(tx, {
          jobId: 'job-design-revisions',
          planRevision: 4,
          plan: plan(99)
        })
      ),
    DesignPlanRevisionConflictError
  )
})

test('execution finalization retains current revision with TTL; expiry and job cascade remove it', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-design-revisions-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const db = createIsolatedTestDatabase(dataDir)
  t.after(() => closeIsolatedTestDatabase(db))
  await seedMinimalJob(db, 'job-design-expiry', 'running')
  for (let revision = 1; revision <= 3; revision += 1) {
    putDesignPlanRevisionInTx(db, {
      jobId: 'job-design-expiry',
      planRevision: revision,
      plan: plan(revision)
    })
  }

  const expiredAt = Math.floor(Date.now() / 1000) - 1
  finalizeDesignPlanRevisions(db, 'job-design-expiry', 3, expiredAt)
  const retained = await db
    .select()
    .from(designPlanRevisions)
    .where(eq(designPlanRevisions.jobId, 'job-design-expiry'))
  assert.equal(retained.length, 1)
  assert.equal(retained[0]?.planRevision, 3)
  assert.equal(retained[0]?.expiresAt, expiredAt)

  assert.equal(deleteExpiredDesignPlanRevisions(db).deleted, 1)
  assert.equal(readDesignPlanRevision(db, 'job-design-expiry', 3), null)

  putDesignPlanRevisionInTx(db, {
    jobId: 'job-design-expiry',
    planRevision: 4,
    plan: plan(4)
  })
  await db.delete(threadJobs).where(eq(threadJobs.id, 'job-design-expiry'))
  const cascaded = await db
    .select()
    .from(designPlanRevisions)
    .where(
      and(
        eq(designPlanRevisions.jobId, 'job-design-expiry'),
        eq(designPlanRevisions.planRevision, 4)
      )
    )
  assert.equal(cascaded.length, 0)
})
