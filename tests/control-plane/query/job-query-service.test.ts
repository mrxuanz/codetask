import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { JobQueryServiceImpl } from '../../../src/server/application/job-query-service'
import type { JobAggregateView } from '../../../src/server/application/ports/job-repository'
import type { ThreadJobDto } from '@shared/contracts/jobs'

function makeLegacyJob(
  overrides: Partial<ThreadJobDto> & Pick<ThreadJobDto, 'id'>
): ThreadJobDto {
  return {
    id: overrides.id,
    threadId: overrides.threadId ?? `thread-${overrides.id}`,
    draftMessageId: overrides.draftMessageId ?? `draft-${overrides.id}`,
    title: overrides.title ?? `Job ${overrides.id}`,
    summary: overrides.summary ?? '',
    status: overrides.status ?? 'running',
    planProgress:
      overrides.planProgress ?? {
        phase: 'idle',
        status: 'pending',
        contextsRegistered: 0,
        contextsTotal: 0
      },
    taskProgress:
      overrides.taskProgress ?? {
        phase: 'idle',
        status: 'pending',
        currentIndex: 0,
        total: 0,
        tasks: []
      },
    abilities: overrides.abilities ?? [],
    plan: overrides.plan,
    referenceManifest: overrides.referenceManifest,
    referenceManifestStale: overrides.referenceManifestStale,
    workspacePath: overrides.workspacePath,
    lastError: overrides.lastError,
    lifecycle: overrides.lifecycle,
    execution: overrides.execution,
    failure: overrides.failure,
    recovery: overrides.recovery,
    availableActions: overrides.availableActions,
    stateRevision: overrides.stateRevision,
    queue: overrides.queue,
    planRevision: overrides.planRevision ?? null,
    draftConfirmedAt: overrides.draftConfirmedAt ?? null,
    planConfirmedAt: overrides.planConfirmedAt ?? null,
    designSessionId: overrides.designSessionId ?? null,
    snapshotDraftRevision: overrides.snapshotDraftRevision ?? null,
    snapshotPlanRevision: overrides.snapshotPlanRevision ?? null,
    snapshotManifestRevision: overrides.snapshotManifestRevision ?? null,
    createdAt: overrides.createdAt ?? 1000,
    updatedAt: overrides.updatedAt ?? 2000
  }
}

function makeAggregate(
  overrides: Partial<JobAggregateView> & Pick<JobAggregateView, 'id'>
): JobAggregateView {
  return {
    id: overrides.id,
    threadId: overrides.threadId ?? `thread-${overrides.id}`,
    projectId: overrides.projectId ?? `project-${overrides.id}`,
    state: overrides.state ?? 'execution_running',
    stateRevision: overrides.stateRevision ?? 1,
    controlIntent: overrides.controlIntent ?? 'none',
    resumeTarget: overrides.resumeTarget ?? null,
    currentPlanRevision: overrides.currentPlanRevision ?? 1,
    executionGeneration: overrides.executionGeneration ?? 0,
    activeRunId: overrides.activeRunId ?? null,
    lastFailureId: overrides.lastFailureId ?? null
  }
}

describe('JobQueryService task snapshots', () => {
  it('overlays control-plane authoritative fields on legacy task snapshot', async () => {
    const aggregate = makeAggregate({
      id: 'job-1',
      state: 'paused',
      stateRevision: 7,
      activeRunId: 'run-1'
    })
    const legacy = makeLegacyJob({
      id: 'job-1',
      status: 'running',
      availableActions: ['delete']
    })

    const service = new JobQueryServiceImpl({
      getJobAggregate: () => aggregate,
      listJobAggregates: () => [aggregate],
      getLegacyJobSnapshot: async () => legacy,
      listLegacyJobSnapshots: async () => ({ jobs: [legacy], total: 1 }),
      getJobTimestamps: () => ({ createdAtMs: 11, updatedAtMs: 22, terminalAtMs: null })
    })

    const control = service.getJob('job-1', { username: 'u1' })
    const task = await service.getTaskJob('job-1', { username: 'u1' })

    assert.notEqual(control, null)
    assert.notEqual(task, null)
    assert.equal(task?.status, 'paused')
    assert.equal(task?.state, 'paused')
    assert.equal(task?.projectId, 'project-job-1')
    assert.equal(task?.stateRevision, 7)
    assert.equal(task?.activeRunId, 'run-1')
    assert.deepEqual(task?.availableActions, control?.availableActions)
    assert.equal(task?.createdAtMs, 11)
    assert.equal(task?.updatedAtMs, 22)
  })

  it('keeps legacy-only jobs unchanged in task list snapshots', async () => {
    const aggregate = makeAggregate({
      id: 'job-1',
      state: 'execution_running',
      stateRevision: 3
    })
    const legacyWithControl = makeLegacyJob({
      id: 'job-1',
      status: 'pending'
    })
    const legacyOnly = makeLegacyJob({
      id: 'job-2',
      status: 'failed',
      availableActions: ['continue', 'delete']
    })

    const service = new JobQueryServiceImpl({
      getJobAggregate: (_actor, jobId) => (jobId === 'job-1' ? aggregate : null),
      listJobAggregates: () => [aggregate],
      getLegacyJobSnapshot: async (_actor, jobId) =>
        jobId === 'job-1' ? legacyWithControl : legacyOnly,
      listLegacyJobSnapshots: async () => ({
        jobs: [legacyWithControl, legacyOnly],
        total: 2
      }),
      getJobTimestamps: () => ({ createdAtMs: 11, updatedAtMs: 22, terminalAtMs: null })
    })

    const result = await service.listTaskJobs({ username: 'u1' })

    assert.equal(result.total, 2)
    assert.equal(result.jobs[0]?.id, 'job-1')
    assert.equal(result.jobs[0]?.stateRevision, 3)
    assert.equal(result.jobs[0]?.state, 'execution_running')
    assert.equal(result.jobs[0]?.status, 'running')

    assert.equal(result.jobs[1]?.id, 'job-2')
    assert.equal(result.jobs[1]?.stateRevision, undefined)
    assert.equal(result.jobs[1]?.state, undefined)
    assert.deepEqual(result.jobs[1]?.availableActions, ['continue', 'delete'])
    assert.equal(result.jobs[1]?.status, 'failed')
  })
})
