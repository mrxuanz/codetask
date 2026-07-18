import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { JobQueryServiceImpl } from '../../../src/server/application/job-query-service'
import type { JobDetailView } from '../../../src/server/application/ports/job-repository'
import type { TaskRow } from '../../../src/server/application/ports/task-repository'

function makeJobDetail(
  overrides: Partial<JobDetailView> & Pick<JobDetailView, 'id'>
): JobDetailView {
  return {
    id: overrides.id,
    threadId: overrides.threadId ?? `thread-${overrides.id}`,
    projectId: overrides.projectId ?? `project-${overrides.id}`,
    draftMessageId: overrides.draftMessageId ?? `draft-${overrides.id}`,
    title: overrides.title ?? `Job ${overrides.id}`,
    requirementsSummary: overrides.requirementsSummary ?? 'summary',
    state: overrides.state ?? 'execution_running',
    stateRevision: overrides.stateRevision ?? 1,
    controlIntent: overrides.controlIntent ?? 'none',
    resumeTarget: overrides.resumeTarget ?? null,
    currentPlanRevision: overrides.currentPlanRevision ?? 1,
    executionGeneration: overrides.executionGeneration ?? 0,
    activeRunId: overrides.activeRunId ?? null,
    lastFailureId: overrides.lastFailureId ?? null,
    createdAtMs: overrides.createdAtMs ?? 11,
    updatedAtMs: overrides.updatedAtMs ?? 22,
    terminalAtMs: overrides.terminalAtMs ?? null
  }
}

describe('JobQueryService control projections', () => {
  it('builds task snapshots from control tables only', async () => {
    const job = makeJobDetail({
      id: 'job-1',
      state: 'paused',
      stateRevision: 7,
      activeRunId: 'run-1',
      lastFailureId: 'failure-1'
    })
    const tasks: TaskRow[] = [
      {
        jobId: 'job-1',
        executionGeneration: 0,
        taskId: 'task-1',
        sourcePlanRevision: 1,
        state: 'completed',
        sortOrder: 1,
        originKind: null,
        parentTaskId: null,
        title: 'Task 1',
        abilityCode: 'code',
        coreCode: null,
        createdAtMs: 1,
        updatedAtMs: 2
      }
    ]

    const service = new JobQueryServiceImpl({
      getOwnedJobDetail: () => job,
      listOwnedJobDetails: () => ({ jobs: [job], total: 1 }),
      listTasksForGeneration: () => tasks,
      getJobFailure: () => ({
        code: 'runtime.interrupted',
        recoverability: 'recoverable',
        reason: 'The runtime exited unexpectedly.'
      })
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
    assert.deepEqual(control?.failure, {
      code: 'runtime.interrupted',
      recoverability: 'recoverable',
      reason: 'The runtime exited unexpectedly.'
    })
    assert.equal(task?.createdAtMs, 11)
    assert.equal(task?.updatedAtMs, 22)
    assert.equal(task?.taskProgress.total, 1)
    assert.equal(task?.recovery?.recoverable, true)
  })

  it('lists owned control jobs without legacy snapshots', async () => {
    const jobOne = makeJobDetail({ id: 'job-1', state: 'execution_queued', stateRevision: 3 })
    const jobTwo = makeJobDetail({ id: 'job-2', state: 'failed', stateRevision: 5 })

    const service = new JobQueryServiceImpl({
      getOwnedJobDetail: (_actor, jobId) => (jobId === 'job-1' ? jobOne : jobId === 'job-2' ? jobTwo : null),
      listOwnedJobDetails: () => ({ jobs: [jobOne, jobTwo], total: 2 }),
      listTasksForGeneration: () => []
    })

    const result = await service.listTaskJobs({ username: 'u1' })

    assert.equal(result.total, 2)
    assert.equal(result.jobs[0]?.id, 'job-1')
    assert.equal(result.jobs[0]?.stateRevision, 3)
    assert.equal(result.jobs[0]?.state, 'execution_queued')
    assert.equal(result.jobs[0]?.status, 'pending')
    assert.equal(result.jobs[1]?.id, 'job-2')
    assert.equal(result.jobs[1]?.state, 'failed')
    assert.deepEqual(result.jobs[1]?.availableActions, ['restart_execution', 'delete'])
  })
})
