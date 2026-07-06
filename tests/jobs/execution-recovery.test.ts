import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTurnError } from '../../src/shared/turn-errors/turn-error.ts'
import { isRecoverableWorkflowBlock } from '../../src/shared/job-recovery.ts'
import {
  prepareInterruptedExecutionResume,
  resetInterruptedGateVerification,
  resetInterruptedRunningTasks,
  resetInterruptedVerificationInProgress,
  syncTaskProgressForJobFailure
} from '../../src/server/jobs/execution-recovery.ts'
import type { GateMilestoneState, GateSliceState } from '../../src/server/jobs/execution-gate.ts'

describe('isRecoverableWorkflowBlock', () => {
  it('recognizes deadlock workflow block by TurnError code', () => {
    assert.equal(isRecoverableWorkflowBlock(createTurnError('workflow.deadlock').toDto()), true)
  })

  it('rejects real subtask failures', () => {
    assert.equal(
      isRecoverableWorkflowBlock(createTurnError('workflow.failed_block').toDto()),
      false
    )
    assert.equal(
      isRecoverableWorkflowBlock(createTurnError('task.terminal_failure').toDto()),
      false
    )
    assert.equal(isRecoverableWorkflowBlock(null), false)
  })
})

describe('execution recovery helpers', () => {
  it('resets verifying slice back to ready-for-verification', () => {
    const slices: GateSliceState[] = [
      {
        id: 'm1-s1',
        milestoneId: 'm1',
        status: 'completed',
        runtimeStatus: 'verifying',
        verificationStatus: null,
        dependsOnSliceIds: [],
        tasks: []
      }
    ]
    const milestones: GateMilestoneState[] = []

    assert.equal(resetInterruptedGateVerification(slices, milestones), true)
    assert.equal(slices[0]?.runtimeStatus, 'ready-for-verification')
  })

  it('resets running tasks to queued', () => {
    const items = [
      {
        id: 'm1-s1-t1',
        title: 't1',
        status: 'running' as const,
        executionStatus: 'running',
        evidenceStatus: null,
        errorMessage: 'stale',
        coreCode: null
      }
    ]

    assert.equal(resetInterruptedRunningTasks(items), true)
    assert.equal(items[0]?.status, 'queued')
    assert.equal(items[0]?.executionStatus, 'queued')
    assert.equal(items[0]?.errorMessage, null)
  })

  it('prepareInterruptedExecutionResume clones and repairs progress', () => {
    const source = {
      phase: 'failed' as const,
      status: 'failed' as const,
      currentIndex: 2,
      total: 10,
      currentTaskId: null,
      message: null,
      progressCode: 'execution.workflow_deadlock' as const,
      progressParams: null,
      tasks: [
        {
          id: 'm1-s1-t1',
          title: 'done',
          status: 'completed' as const,
          executionStatus: 'completed',
          evidenceStatus: 'basic-facts-ok',
          errorMessage: null,
          coreCode: null
        },
        {
          id: 'm1-s2-t1',
          title: 'stuck',
          status: 'running' as const,
          executionStatus: 'running',
          evidenceStatus: null,
          errorMessage: null,
          coreCode: null
        }
      ],
      slices: [{ id: 'm1-s2', runtimeStatus: 'verifying', verificationStatus: null }],
      milestones: [{ id: 'm1', verificationStatus: 'verifying' }]
    }

    const { progress, recovered } = prepareInterruptedExecutionResume(source)

    assert.equal(recovered, true)
    assert.equal(source.tasks[1]?.status, 'running')
    assert.equal(progress.tasks[1]?.status, 'queued')
    assert.equal(progress.slices?.[0]?.runtimeStatus, 'ready-for-verification')
    assert.equal(progress.milestones?.[0]?.verificationStatus, 'ready-for-verification')
    assert.equal(resetInterruptedVerificationInProgress({ slices: [], milestones: [] }), false)
  })

  it('syncTaskProgressForJobFailure marks the in-flight task failed', () => {
    const synced = syncTaskProgressForJobFailure(
      {
        phase: 'running',
        status: 'running',
        currentIndex: 6,
        total: 7,
        currentTaskId: 'm4-s1-t1',
        message: null,
        progressCode: 'execution.running_task',
        progressParams: { id: 'm4-s1-t1' },
        tasks: [
          {
            id: 'm3-s3-t1',
            title: 'done',
            status: 'completed',
            executionStatus: 'completed',
            evidenceStatus: 'basic-facts-ok',
            errorMessage: null,
            coreCode: null
          },
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
      },
      new Error('Task MCP backend port is not initialized')
    )

    assert.equal(synced.phase, 'failed')
    assert.equal(synced.status, 'failed')
    assert.equal(synced.currentTaskId, null)
    assert.equal(synced.progressCode, 'execution.failed')
    assert.equal(synced.message, null)
    assert.equal(synced.tasks[1]?.status, 'failed')
    assert.equal(synced.tasks[1]?.executionStatus, 'failed')
    assert.equal(synced.tasks[1]?.error?.code, 'turn.unknown')
  })
})
