import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { and, eq, isNull } from 'drizzle-orm'
import { bootstrapRuntime, resetAppContextForTests } from '../../src/server/bootstrap'
import { getDb } from '../../src/server/db'
import { saveJobAbilities, saveJobPlan } from '../../src/server/db/job-plan'
import {
  projects,
  threadJobs,
  threadMessages,
  threads
} from '../../src/server/db/schema'
import { launchJobFromDesignSession } from '../../src/server/design-session/service'
import {
  assertConfirmRevisionMatches,
  captureConfirmRevisionExpectations
} from '../../src/server/design-session/launch'
import { AppError } from '../../src/server/error'
import {
  resetJobReconcileForTests,
  stopWorkloadReconcilerForTests
} from '../../src/server/legacy-control-plane/reconcile'
import { ensureStartupWorkloadReady } from '../../src/server/legacy-control-plane/workload-slot'
import { resetWorkloadRunControllersForTests } from '../../src/server/legacy-control-plane/workload-slot-store'
import { buildJobReferenceManifest } from '../../src/shared/job-references'
import type { SavedJobPlan } from '../../src/shared/contracts/plan'

const USER = 'user'
const THREAD_ID = 'thread-1'
const SESSION_ID = 'ds-confirm-cas'

let dataDir = ''

function samplePlan(): SavedJobPlan {
  return {
    milestones: [
      {
        title: 'M1',
        successCriteria: 'done',
        confirmed: true,
        slices: [
          {
            title: 'S1',
            successCriteria: 'done',
            confirmed: true,
            tasks: [
              {
                title: 'T1',
                description: 'd',
                taskKind: 'general-implementation',
                abilityCode: 'general-implementation',
                confirmed: true
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
        confirmed: true
      }
    ]
  }
}

async function setupDb(): Promise<void> {
  dataDir = mkdtempSync(join(tmpdir(), 'codetask-confirm-cas-'))
  await resetAppContextForTests()
  resetJobReconcileForTests()
  bootstrapRuntime({ dataDir })
  await ensureStartupWorkloadReady()
  stopWorkloadReconcilerForTests()
}

async function teardownDb(): Promise<void> {
  resetWorkloadRunControllersForTests()
  await resetAppContextForTests()
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

async function seedLaunchableSession(): Promise<void> {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const projectId = 'proj-1'
  const draftId = 'draft-1'
  const manifest = buildJobReferenceManifest({
    jobId: SESSION_ID,
    threadId: THREAD_ID,
    manifestRevision: 1,
    references: []
  })

  await db.insert(projects).values({
    id: projectId,
    username: USER,
    title: 'P',
    workspaceRoot: join(dataDir, 'workspace'),
    createdAt: now,
    updatedAt: now
  })
  await db.insert(threads).values({
    id: THREAD_ID,
    username: USER,
    projectId,
    title: 'T',
    status: 'draft',
    conversationId: 'conv-1',
    coreCode: 'cursor',
    runtimeStatus: 'idle',
    coreRuntimeJson: '{}',
    createdAt: now,
    updatedAt: now
  })
  await db.insert(threadMessages).values({
    id: draftId,
    threadId: THREAD_ID,
    username: USER,
    role: 'assistant',
    kind: 'task-launch-draft',
    content: '{}',
    coreCode: 'cursor',
    conversationId: 'conv-1',
    payloadJson: JSON.stringify({ title: 'Draft' }),
    createdAt: String(now)
  })
  await db.insert(threadJobs).values({
    id: SESSION_ID,
    threadId: THREAD_ID,
    username: USER,
    draftMessageId: draftId,
    title: 'Confirm CAS',
    summary: '',
    status: 'plan_editing',
    phase: 'ready_to_launch',
    workspacePath: join(dataDir, 'workspace'),
    draftRevision: 2,
    planRevision: 1,
    manifestRevision: 1,
    corpusRevision: 1,
    frozenCorpusRevision: 1,
    referenceManifestJson: JSON.stringify(manifest),
    draftConfirmedAt: now,
    planPhase: 'plan_ready',
    planStatus: 'completed',
    planContextsRegistered: 1,
    planContextsTotal: 1,
    createdAt: now,
    updatedAt: now
  })

  await saveJobPlan(db, SESSION_ID, samplePlan())
  await saveJobAbilities(db, SESSION_ID, [
    { abilityCode: 'general-implementation', recommendedCoreCode: 'codex' }
  ])
}

test('captureConfirmRevisionMatches rejects stale revisions', () => {
  const expected = { draftRevision: 2, planRevision: 1, manifestRevision: 1 }
  assert.throws(
    () =>
      assertConfirmRevisionMatches(
        {
          draftRevision: 2,
          planRevision: 2,
          manifestRevision: 1
        } as Parameters<typeof assertConfirmRevisionMatches>[0],
        expected
      ),
    (error: unknown) =>
      error instanceof AppError && error.data.turnErrorCode === 'plan.confirm_conflict'
  )
})

test('confirm CAS rejects stale revision expectations', async () => {
  await setupDb()
  try {
    await seedLaunchableSession()
    const db = getDb()
    const session = (
      await db.select().from(threadJobs).where(eq(threadJobs.id, SESSION_ID)).limit(1)
    )[0]!
    const expected = captureConfirmRevisionExpectations(session)

    await db
      .update(threadJobs)
      .set({ planRevision: expected.planRevision + 1, updatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(threadJobs.id, SESSION_ID))

    const current = (
      await db.select().from(threadJobs).where(eq(threadJobs.id, SESSION_ID)).limit(1)
    )[0]!
    assert.throws(
      () => assertConfirmRevisionMatches(current, expected),
      (error: unknown) =>
        error instanceof AppError && error.data.turnErrorCode === 'plan.confirm_conflict'
    )

    const casResult = db
      .update(threadJobs)
      .set({ status: 'pending', updatedAt: Math.floor(Date.now() / 1000) })
      .where(
        and(
          eq(threadJobs.id, SESSION_ID),
          eq(threadJobs.username, USER),
          eq(threadJobs.threadId, THREAD_ID),
          eq(threadJobs.status, 'plan_editing'),
          isNull(threadJobs.planConfirmedAt),
          eq(threadJobs.draftRevision, expected.draftRevision),
          eq(threadJobs.planRevision, expected.planRevision),
          eq(threadJobs.manifestRevision, expected.manifestRevision)
        )
      )
      .run()
    assert.equal(casResult.changes, 0)

    const row = (
      await db.select().from(threadJobs).where(eq(threadJobs.id, SESSION_ID)).limit(1)
    )[0]
    assert.equal(row?.status, 'plan_editing')
    assert.equal(row?.planConfirmedAt, null)
  } finally {
    await teardownDb()
  }
})

test('duplicate confirm does not re-pending or advance queue twice', async () => {
  await setupDb()
  try {
    await seedLaunchableSession()

    const first = await launchJobFromDesignSession(USER, THREAD_ID, SESSION_ID, {
      skipQueueAdvance: true
    })
    assert.equal(first.status, 'pending')
    const confirmedAt = first.planConfirmedAt

    await assert.rejects(
      () => launchJobFromDesignSession(USER, THREAD_ID, SESSION_ID, { skipQueueAdvance: true }),
      (error: unknown) =>
        error instanceof AppError && error.data.turnErrorCode === 'job.already_launched'
    )

    const row = (
      await getDb().select().from(threadJobs).where(eq(threadJobs.id, SESSION_ID)).limit(1)
    )[0]
    assert.equal(row?.status, 'pending')
    assert.equal(row?.planConfirmedAt, confirmedAt)
    assert.equal(row?.snapshotPlanRevision, captureConfirmRevisionExpectations(row!).planRevision)
  } finally {
    await teardownDb()
  }
})

test('failed confirm CAS rolls back thread and draft side effects', async () => {
  await setupDb()
  try {
    await seedLaunchableSession()
    const db = getDb()
    const expected = captureConfirmRevisionExpectations(
      (await db.select().from(threadJobs).where(eq(threadJobs.id, SESSION_ID)).limit(1))[0]!
    )

    await db.update(threads).set({ activePlanId: null }).where(eq(threads.id, THREAD_ID))
    await db
      .update(threadJobs)
      .set({ planRevision: expected.planRevision + 1, updatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(threadJobs.id, SESSION_ID))

    assert.throws(() => {
      db.transaction(() => {
        db.update(threads)
          .set({ activePlanId: SESSION_ID, updatedAt: Math.floor(Date.now() / 1000) })
          .where(and(eq(threads.id, THREAD_ID), eq(threads.username, USER)))
          .run()

        db.update(threadMessages)
          .set({
            payloadJson: JSON.stringify({ linkedPlanId: SESSION_ID, designSessionId: SESSION_ID })
          })
          .where(eq(threadMessages.id, 'draft-1'))
          .run()

        const current = db
          .select()
          .from(threadJobs)
          .where(eq(threadJobs.id, SESSION_ID))
          .limit(1)
          .all()[0]!
        assertConfirmRevisionMatches(current, expected)
      })
    })

    const thread = (
      await db.select().from(threads).where(eq(threads.id, THREAD_ID)).limit(1)
    )[0]
    assert.equal(thread?.activePlanId, null)

    const message = (
      await db.select().from(threadMessages).where(eq(threadMessages.id, 'draft-1')).limit(1)
    )[0]
    const payload = JSON.parse(message?.payloadJson ?? '{}') as Record<string, unknown>
    assert.equal(payload.linkedPlanId, undefined)

    const job = (await db.select().from(threadJobs).where(eq(threadJobs.id, SESSION_ID)).limit(1))[0]
    assert.equal(job?.status, 'plan_editing')
    assert.equal(job?.planConfirmedAt, null)
    assert.equal(job?.taskPhase, 'idle')
    assert.equal(job?.taskTotal, 0)
  } finally {
    await teardownDb()
  }
})
