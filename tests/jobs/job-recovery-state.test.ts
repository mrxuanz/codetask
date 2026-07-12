import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTurnError } from '../../src/shared/turn-errors/turn-error.ts'
import { deriveJobRecoveryState } from '../../src/shared/job-recovery-state.ts'
import type { ThreadJobDto } from '../../src/shared/contracts/jobs.ts'

function baseJob(overrides: Partial<ThreadJobDto> = {}): ThreadJobDto {
  return {
    id: 'job-1',
    threadId: 'thread-1',
    draftMessageId: 'draft-1',
    title: 'Test job',
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
      currentIndex: 2,
      total: 3,
      currentTaskId: null,
      message: null,
      progressCode: 'execution.workflow_failed_block',
      progressParams: null,
      tasks: [
        {
          id: 'm1-s1-t1',
          title: 'done',
          status: 'completed',
          executionStatus: 'completed',
          evidenceStatus: 'basic-facts-ok',
          errorMessage: null,
          coreCode: null
        },
        {
          id: 'm2-s3-t2',
          title: 'failed task',
          status: 'failed',
          executionStatus: 'blocked',
          evidenceStatus: 'basic-facts-ok',
          evidence: {
            status: 'blocked',
            summary: '等待 report_task_result 超时',
            changedFiles: [],
            evidence: ['turn ended without report_task_result'],
            validation: { ran: false, outcome: 'skipped' },
            blockers: ['timeout'],
            blockerKind: 'infra',
            recovery: {
              kind: 'infra',
              source: 'classifier',
              confidence: 'high',
              reasons: ['timeout'],
              attempt: 3,
              maxAttempts: 3,
              action: 'terminal-fail'
            }
          },
          errorMessage: '任务 m2-s3-t2 工具层故障重试已达上限 (3)',
          coreCode: null
        }
      ],
      repairGenerations: {
        'task-infra:m2-s3-t2': 3
      }
    },
    abilities: [],
    lastError: createTurnError('workflow.failed_block').toDto(),
    createdAt: 1,
    updatedAt: 2,
    ...overrides
  }
}

describe('deriveJobRecoveryState', () => {
  it('maps paused jobs to continue/restart/delete', () => {
    const state = deriveJobRecoveryState(
      baseJob({
        status: 'paused',
        lastError: null,
        taskProgress: {
          ...baseJob().taskProgress,
          phase: 'running',
          status: 'running',
          message: '用户暂停'
        }
      })
    )
    assert.equal(state.lifecycle, 'paused')
    assert.equal(state.recovery.recoverable, true)
    assert.equal(state.recovery.reason, 'user_paused')
    assert.deepEqual(state.availableActions, ['continue', 'restart', 'delete'])
  })

  it('exposes recoverable infra failure with continue action at 69%', () => {
    const state = deriveJobRecoveryState(
      baseJob({
        taskProgress: {
          ...baseJob().taskProgress,
          currentIndex: 2,
          total: 3,
          tasks: [
            baseJob().taskProgress.tasks[0]!,
            {
              id: 'm2-s3-t2',
              title: 'failed task',
              status: 'failed',
              executionStatus: 'blocked',
              evidence: {
                status: 'blocked',
                summary: '等待 report_task_result 超时',
                changedFiles: [],
                evidence: ['timeout'],
                validation: { ran: false, outcome: 'skipped' },
                blockers: ['timeout'],
                blockerKind: 'infra',
                recovery: {
                  kind: 'infra',
                  source: 'classifier',
                  confidence: 'high',
                  reasons: ['timeout'],
                  attempt: 2,
                  maxAttempts: 3,
                  action: 'infra-retry'
                }
              },
              errorMessage: '任务工具层故障，自动重试 (2/3)',
              coreCode: null
            }
          ],
          repairGenerations: {
            'task-infra:m2-s3-t2': 2
          }
        }
      })
    )

    assert.equal(state.execution.percentage, 33)
    assert.equal(state.execution.failedTaskId, 'm2-s3-t2')
    assert.equal(state.failure.kind, 'infra_retryable')
    assert.equal(state.recovery.recoverable, true)
    assert.equal(state.recovery.reason, 'task_infra_failure')
    assert.equal(state.recovery.nextAction, 'retry_failed_task')
    assert.equal(state.recovery.autoRetryAttempt, 2)
    assert.ok(!state.availableActions.includes('continue'))
    assert.ok(state.availableActions.includes('retry_failed_task'))
    assert.ok(state.availableActions.includes('restart'))
  })

  it('marks terminal exhausted failures as non-recoverable', () => {
    const state = deriveJobRecoveryState(baseJob())
    assert.equal(state.failure.kind, 'terminal')
    assert.equal(state.recovery.recoverable, false)
    assert.equal(state.recovery.reason, 'terminal_exhausted')
    assert.deepEqual(state.availableActions, ['retry_failed_task', 'restart', 'delete'])
  })

  it('recovers workflow deadlock from progressCode without legacy message parsing', () => {
    const state = deriveJobRecoveryState(
      baseJob({
        lastError: createTurnError('workflow.deadlock').toDto(),
        taskProgress: {
          ...baseJob().taskProgress,
          message: null,
          progressCode: 'execution.workflow_deadlock',
          progressParams: null,
          tasks: baseJob().taskProgress.tasks.map((task) => ({
            ...task,
            status: task.id === 'm2-s3-t2' ? 'queued' : task.status,
            executionStatus: 'queued',
            evidence: null,
            errorMessage: null
          }))
        }
      })
    )

    assert.equal(state.recovery.recoverable, true)
    assert.equal(state.recovery.reason, 'workflow_deadlock')
    assert.equal(state.recovery.nextAction, 'continue')
    assert.ok(state.availableActions.includes('continue'))
  })

  it('exposes continue for failed job with interrupted running task', () => {
    const state = deriveJobRecoveryState(
      baseJob({
        lastError: createTurnError('turn.unknown', {
          detail: 'Task MCP backend port is not initialized'
        }).toDto(),
        taskProgress: {
          ...baseJob().taskProgress,
          phase: 'running',
          status: 'running',
          currentTaskId: 'm4-s1-t1',
          message: null,
          progressCode: 'execution.running_task',
          progressParams: { id: 'm4-s1-t1' },
          tasks: [
            baseJob().taskProgress.tasks[0]!,
            {
              id: 'm4-s1-t1',
              title: 'acceptance',
              status: 'running',
              executionStatus: 'running',
              evidenceStatus: null,
              errorMessage:
                'codetask-error:v1:{"v":1,"code":"task.infra_retry","message":"Task m4-s1-t1 tool-layer infrastructure failure; automatic retry (3/3)"}',
              coreCode: 'cursorcli'
            }
          ]
        }
      })
    )

    assert.equal(state.recovery.recoverable, true)
    assert.equal(state.execution.failedTaskId, 'm4-s1-t1')
    assert.ok(state.availableActions.includes('continue'))
    assert.ok(state.availableActions.includes('restart'))
  })

  it('offers pause for running jobs without cancel', () => {
    const state = deriveJobRecoveryState(
      baseJob({
        status: 'running',
        lastError: null,
        taskProgress: {
          ...baseJob().taskProgress,
          phase: 'running',
          status: 'running',
          currentTaskId: 'm1-s1-t1',
          message: null,
          progressCode: 'execution.running_task',
          progressParams: { id: 'm1-s1-t1' },
          tasks: [
            {
              id: 'm1-s1-t1',
              title: 'running',
              status: 'running',
              executionStatus: 'running',
              errorMessage: null,
              coreCode: null
            }
          ]
        }
      })
    )

    assert.equal(state.lifecycle, 'running')
    assert.deepEqual(state.availableActions, ['pause', 'delete'])
  })
})
