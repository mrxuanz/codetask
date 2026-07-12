import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareContinueFailedExecution } from '../../src/server/jobs/continue-failed-job.ts'
import type { ThreadJobDto } from '../../src/shared/contracts/jobs.ts'
import type { SavedJobPlan } from '../../src/server/planner/plan-types.ts'
import { createTurnError } from '../../src/shared/turn-errors/turn-error.ts'

const plan: SavedJobPlan = {
  milestones: [
    {
      id: 'm1',
      title: 'M1',
      slices: [
        {
          id: 'm1-s1',
          title: 'S1',
          tasks: [{ id: 'm1-s1-t1', title: 'T1', abilityCode: 'code', coreCode: null }]
        }
      ]
    },
    {
      id: 'm2',
      title: 'M2',
      slices: [
        {
          id: 'm2-s3',
          title: 'S3',
          tasks: [{ id: 'm2-s3-t2', title: 'T2', abilityCode: 'code', coreCode: null }]
        }
      ]
    }
  ],
  tasks: [
    {
      id: 'm1-s1-t1',
      title: 'T1',
      milestoneIndex: 1,
      sliceIndex: 1,
      taskIndex: 1,
      abilityCode: 'code',
      coreCode: null
    },
    {
      id: 'm2-s3-t2',
      title: 'T2',
      milestoneIndex: 2,
      sliceIndex: 3,
      taskIndex: 2,
      abilityCode: 'code',
      coreCode: null
    }
  ]
}

function failedJob(): ThreadJobDto {
  return {
    id: 'job-1',
    threadId: 'thread-1',
    draftMessageId: 'draft-1',
    title: 'job',
    summary: '',
    status: 'failed',
    planProgress: {
      phase: 'plan_ready',
      status: 'completed',
      contextsRegistered: 0,
      contextsTotal: 0
    },
    taskProgress: {
      phase: 'failed',
      status: 'failed',
      currentIndex: 1,
      total: 2,
      currentTaskId: null,
      message: null,
      progressCode: 'execution.workflow_failed_block',
      tasks: [
        {
          id: 'm1-s1-t1',
          title: 'T1',
          status: 'completed',
          executionStatus: 'completed',
          evidenceStatus: 'basic-facts-ok',
          errorMessage: null,
          coreCode: null
        },
        {
          id: 'm2-s3-t2',
          title: 'T2',
          status: 'failed',
          executionStatus: 'blocked',
          evidence: {
            status: 'blocked',
            summary: 'Cannot find module spriteExtractor',
            changedFiles: [],
            evidence: ['src/lib/spriteExtractor.ts does not exist'],
            validation: { ran: false, outcome: 'not-applicable' },
            blockers: ['Missing file src/lib/spriteExtractor.ts']
          },
          errorMessage: 'Missing dependency: src/lib/spriteExtractor.ts',
          coreCode: null
        }
      ]
    },
    abilities: [],
    lastError: createTurnError('workflow.failed_block').toDto(),
    createdAt: 1,
    updatedAt: 2
  }
}

test('prepareContinueFailedExecution injects prep tasks for dependency failures', () => {
  const prepared = prepareContinueFailedExecution(failedJob(), plan)
  assert.equal(prepared.taskProgress.phase, 'running')
  assert.equal(prepared.taskProgress.status, 'running')
  const blocked = prepared.taskProgress.tasks.find((task) => task.id === 'm2-s3-t2')
  assert.equal(blocked?.executionStatus, 'waiting-on-dependency')
  assert.ok(prepared.plan.tasks.length > plan.tasks.length)
})

test('prepareContinueFailedExecution re-queues tasks failed by turn cancellation', () => {
  const job = failedJob()
  job.taskProgress.tasks[1] = {
    id: 'm2-s3-t2',
    title: 'T2',
    status: 'failed',
    executionStatus: 'failed',
    evidenceStatus: null,
    evidence: null,
    errorMessage:
      'codetask-error:v1:{"v":1,"code":"turn.cancelled","message":"Conversation cancelled","detail":null}',
    coreCode: null
  }

  const prepared = prepareContinueFailedExecution(job, plan)
  const task = prepared.taskProgress.tasks.find((item) => item.id === 'm2-s3-t2')
  assert.equal(task?.status, 'queued')
  assert.equal(task?.executionStatus, 'queued')
  assert.equal(task?.errorMessage, null)
  assert.equal(prepared.taskProgress.phase, 'running')
  assert.equal(prepared.taskProgress.status, 'running')
})

test('prepareContinueFailedExecution re-queues interrupted running task after job failure', () => {
  const job = failedJob()
  job.lastError = createTurnError('turn.unknown', {
    detail: 'Task MCP backend port is not initialized'
  }).toDto()
  job.taskProgress = {
    ...job.taskProgress,
    phase: 'failed',
    status: 'failed',
    currentTaskId: 'm2-s3-t2',
    message: null,
    progressCode: 'execution.running_task',
    progressParams: { id: 'm2-s3-t2' },
    tasks: [
      job.taskProgress.tasks[0]!,
      {
        id: 'm2-s3-t2',
        title: 'T2',
        status: 'failed',
        executionStatus: 'failed',
        evidenceStatus: null,
        evidence: null,
        errorMessage: 'Task MCP backend port is not initialized',
        coreCode: 'cursorcli'
      }
    ]
  }

  const prepared = prepareContinueFailedExecution(job, plan)
  const task = prepared.taskProgress.tasks.find((item) => item.id === 'm2-s3-t2')
  assert.equal(task?.status, 'queued')
  assert.equal(task?.executionStatus, 'queued')
  assert.equal(task?.errorMessage, null)
  assert.equal(prepared.taskProgress.phase, 'running')
})

test('prepareContinueFailedExecution resets infra retry tasks to retry-queued', () => {
  const job = failedJob()
  job.taskProgress.tasks[1] = {
    ...job.taskProgress.tasks[1]!,
    evidence: {
      status: 'blocked',
      summary: 'timeout',
      changedFiles: [],
      evidence: ['timeout'],
      validation: { ran: false, outcome: 'skipped' },
      blockers: ['timeout'],
      blockerKind: 'infra'
    },
    errorMessage: 'timeout'
  }

  const prepared = prepareContinueFailedExecution(job, plan)
  const task = prepared.taskProgress.tasks.find((item) => item.id === 'm2-s3-t2')
  assert.equal(task?.status, 'queued')
  assert.equal(task?.executionStatus, 'retry-queued')
})

test('prepareContinueFailedExecution resumes slice gate failures without restart', () => {
  const job = failedJob()
  job.lastError = createTurnError('task.terminal_failure', {
    params: { taskId: 'm1-s1' }
  }).toDto()
  job.taskProgress = {
    ...job.taskProgress,
    progressCode: 'execution.slice_blocked',
    progressParams: { id: 'm1-s1' },
    slices: [
      {
        id: 'm1-s1',
        runtimeStatus: 'verification-blocked',
        verificationStatus: 'blocked'
      }
    ],
    tasks: job.taskProgress.tasks.map((task) => ({
      ...task,
      status: 'completed' as const,
      executionStatus: 'completed' as const,
      evidence: null,
      errorMessage: null
    })),
    repairGenerations: {
      'slice:m1-s1': 3
    }
  }

  const prepared = prepareContinueFailedExecution(job, plan)
  assert.equal(prepared.taskProgress.phase, 'running')
  assert.equal(prepared.taskProgress.status, 'running')
  assert.equal(prepared.taskProgress.progressCode, 'execution.resuming')
  const slice = prepared.taskProgress.slices?.find((item) => item.id === 'm1-s1')
  assert.equal(slice?.verificationStatus, 'ready-for-verification')
  assert.equal(prepared.taskProgress.repairGenerations?.['slice:m1-s1'], undefined)
})
