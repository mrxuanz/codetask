import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isHumanDependencyPause,
  isRestartInterruptedPause,
  resolveStaleExecutionJobAction
} from '../../src/server/legacy-control-plane/execution-recovery'
import { requiresExclusiveWorkspaceLease } from '../../src/shared/workspace-access.ts'
import type { ThreadJobDto } from '../../src/shared/contracts/jobs.ts'

function basePausedJob(
  overrides: Partial<ThreadJobDto> & {
    taskProgress?: ThreadJobDto['taskProgress']
  } = {}
): ThreadJobDto {
  return {
    id: 'job-1',
    threadId: 'thread-1',
    draftMessageId: 'draft-1',
    title: 'Job',
    summary: '',
    status: 'paused',
    planProgress: {
      phase: 'plan_ready',
      status: 'completed',
      contextsRegistered: 0,
      contextsTotal: 0
    },
    taskProgress: {
      phase: 'running',
      status: 'running',
      currentIndex: 1,
      total: 2,
      currentTaskId: 't2',
      tasks: [
        { id: 't1', title: 'T1', status: 'completed', executionStatus: 'completed' },
        { id: 't2', title: 'T2', status: 'queued', executionStatus: 'queued' }
      ]
    },
    abilities: [],
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  } as ThreadJobDto
}

test('continue_after_pause intent: pausing settle action remains finalize-user-pause', () => {
  const pausing = basePausedJob({
    status: 'pausing',
    continueAfterPause: true,
    suspensionKind: 'user_pause'
  })
  assert.equal(resolveStaleExecutionJobAction(pausing), 'finalize-user-pause')
})

test('policy_hold uncertain recovery is never auto-resumed', () => {
  const held = basePausedJob({
    suspensionKind: 'policy_hold',
    recoveryReason: 'uncertain_provider_outcome',
    lastError: null
  })
  assert.equal(isRestartInterruptedPause(held), false)
  assert.equal(resolveStaleExecutionJobAction(held), 'noop')
})

test('structured user_pause wins over restart heuristic', () => {
  const paused = basePausedJob({
    suspensionKind: 'user_pause',
    lastError: null
  })
  assert.equal(isRestartInterruptedPause(paused), false)
  assert.equal(resolveStaleExecutionJobAction(paused), 'noop')
})

test('isHumanDependencyPause detects dependency-human evidence', () => {
  const job = basePausedJob({
    taskProgress: {
      phase: 'running',
      status: 'running',
      currentIndex: 1,
      total: 1,
      currentTaskId: 't1',
      tasks: [
        {
          id: 't1',
          title: 'T1',
          status: 'failed',
          executionStatus: 'failed',
          blockerKind: 'dependency-human',
          recoveryAction: 'pause-human'
        }
      ]
    }
  })
  assert.equal(isHumanDependencyPause(job), true)
  assert.equal(isRestartInterruptedPause(job), false)
})

test('only exclusive-write requires main workspace lease', () => {
  assert.equal(requiresExclusiveWorkspaceLease('metadata'), false)
  assert.equal(requiresExclusiveWorkspaceLease('live-read'), false)
  assert.equal(requiresExclusiveWorkspaceLease('snapshot-read'), false)
  assert.equal(requiresExclusiveWorkspaceLease('live-read'), false)
  assert.equal(requiresExclusiveWorkspaceLease('exclusive-write'), true)
})
