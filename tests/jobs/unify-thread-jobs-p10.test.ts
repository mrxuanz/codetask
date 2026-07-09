import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isPlanningJobStatus,
  isPlanningWorkspaceStatus
} from '../../src/shared/design-session'
import { resolveDraftPlanReference } from '../../src/shared/draft-plan-resolve'
import { validateLaunchPreconditions } from '../../src/server/design-session/launch'
import type { ThreadJob } from '../../src/server/db/schema'
import type { SavedJobPlan } from '../../src/shared/contracts/plan'
import { buildJobReferenceManifest } from '../../src/shared/job-references'
import { AppError } from '../../src/server/error'

test('isPlanningJobStatus only matches planning and plan_editing', () => {
  assert.equal(isPlanningJobStatus('planning'), true)
  assert.equal(isPlanningJobStatus('plan_editing'), true)
  assert.equal(isPlanningJobStatus('plan_confirmed'), false)
  assert.equal(isPlanningJobStatus('pending'), false)
  assert.equal(isPlanningJobStatus(''), false)
})

test('isPlanningWorkspaceStatus matches /plans workspace statuses', () => {
  for (const status of ['planning', 'plan_editing', 'cancelled', 'failed'] as const) {
    assert.equal(isPlanningWorkspaceStatus(status), true)
  }
  assert.equal(isPlanningWorkspaceStatus('running'), false)
})

test('resolveDraftPlanReference single-id lifecycle: planning → launched', () => {
  const planId = 'job-same-id'

  const duringPlanning = resolveDraftPlanReference({
    linkedPlanId: planId,
    planId,
    planStatus: 'plan_editing'
  })
  assert.equal(duringPlanning.activePlanId, planId)
  assert.equal(duringPlanning.launchedJobId, null)

  const afterConfirm = resolveDraftPlanReference({
    linkedPlanId: planId,
    planId,
    planConfirmedAt: 1_700_000_000,
    planStatus: 'pending'
  })
  assert.equal(afterConfirm.activePlanId, planId)
  assert.equal(afterConfirm.launchedJobId, planId)
})

function sampleJob(overrides: Partial<ThreadJob> = {}): ThreadJob {
  return {
    id: 'job-plan-1',
    threadId: 'thread-1',
    username: 'user',
    draftMessageId: 'msg-1',
    title: 'Plan',
    summary: '',
    workspacePath: '/workspace/project',
    phase: 'ready_to_launch',
    draftRevision: 1,
    planRevision: 1,
    status: 'plan_editing',
    planPhase: 'plan_ready',
    planStatus: 'completed',
    planContextsRegistered: 0,
    planContextsTotal: 0,
    planMessage: null,
    planCountsJson: '{}',
    taskPhase: 'idle',
    taskStatus: 'pending',
    taskCurrentIndex: 0,
    taskTotal: 0,
    taskCurrentTaskId: null,
    taskMessage: null,
    taskMetaJson: '{}',
    referenceManifestJson: null,
    manifestRevision: 1,
    corpusRevision: 1,
    frozenCorpusRevision: 1,
    planArtifactId: null,
    planArtifactPath: null,
    planSummaryJson: null,
    draftConfirmedAt: 1,
    planConfirmedAt: null,
    designSessionId: null,
    snapshotDraftRevision: null,
    snapshotPlanRevision: null,
    snapshotManifestRevision: null,
    executionLeaseOwner: null,
    executionLeaseExpiresAt: null,
    activeRunId: null,
    terminalAt: null,
    runtimeBytes: 0,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function samplePlan(): SavedJobPlan {
  return {
    milestones: [],
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
        successCriteria: 'done'
      }
    ]
  }
}

test('validateLaunchPreconditions accepts ready ThreadJob and rejects already launched', () => {
  const plan = samplePlan()
  const manifest = buildJobReferenceManifest({
    jobId: 'job-plan-1',
    threadId: 'thread-1',
    references: []
  })

  assert.doesNotThrow(() =>
    validateLaunchPreconditions({
      session: sampleJob(),
      plan,
      manifest
    })
  )

  assert.throws(
    () =>
      validateLaunchPreconditions({
        session: sampleJob({ planConfirmedAt: 99 }),
        plan,
        manifest
      }),
    (error: unknown) =>
      error instanceof AppError && error.data.turnErrorCode === 'job.already_launched'
  )
})
