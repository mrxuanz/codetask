import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertTaskWorkerAcpCompletion,
  isEmptyAcpReply
} from '../../src/server/agent-runtime/cursor-acp/turn-guards'
import {
  CURSOR_KEEPALIVE_TIMEOUT_MESSAGE,
  CURSOR_TASK_WORKER_EMPTY_TURN_MESSAGE,
  EMPTY_ACP_REPLY_PLACEHOLDER
} from '../../src/server/agent-runtime/cursor-acp/messages'
import { isRetryableTurnError } from '../../src/server/agent-runtime/retry'
import {
  resolveEvidenceMissRecovery,
  resolveTaskInfraRecovery
} from '../../src/server/jobs/task-blocker/recovery'

test('isEmptyAcpReply treats placeholder and blank as empty', () => {
  assert.equal(isEmptyAcpReply(''), true)
  assert.equal(isEmptyAcpReply('   '), true)
  assert.equal(isEmptyAcpReply(EMPTY_ACP_REPLY_PLACEHOLDER), true)
  assert.equal(isEmptyAcpReply('done'), false)
})

test('assertTaskWorkerAcpCompletion rejects empty task-worker turn', () => {
  assert.throws(
    () =>
      assertTaskWorkerAcpCompletion({
        role: 'task-worker',
        reply: '',
        stderrTail: '',
        promptSettledError: null
      }),
    (error: unknown) => {
      assert.equal((error as Error).message, CURSOR_TASK_WORKER_EMPTY_TURN_MESSAGE)
      return true
    }
  )
})

test('assertTaskWorkerAcpCompletion allows conversation empty reply', () => {
  assert.doesNotThrow(() =>
    assertTaskWorkerAcpCompletion({
      role: 'conversation',
      reply: '',
      stderrTail: '',
      promptSettledError: null
    })
  )
})

test('assertTaskWorkerAcpCompletion rejects keepalive signal in stderr for task-worker', () => {
  assert.throws(
    () =>
      assertTaskWorkerAcpCompletion({
        role: 'task-worker',
        reply: 'partial',
        stderrTail: 'HTTP/2 keepalive ping timed out after 5000ms',
        promptSettledError: null
      }),
    (error: unknown) => {
      assert.equal((error as Error).message, CURSOR_KEEPALIVE_TIMEOUT_MESSAGE)
      return true
    }
  )
})

test('cursor acp guard errors are retryable at CODETASK turn layer', () => {
  assert.equal(isRetryableTurnError(new Error(CURSOR_TASK_WORKER_EMPTY_TURN_MESSAGE)), true)
  assert.equal(
    isRetryableTurnError(new Error('Cursor ACP 等待更新超时（120s，Agent 可能已挂起或云端断流）')),
    true
  )
})

test('resolveEvidenceMissRecovery schedules infra retry for evidence timeout', () => {
  const message = '任务 m2-s3-t2 等待 report_task_result 超时'
  const progress = {
    phase: 'running' as const,
    status: 'running' as const,
    currentIndex: 0,
    total: 1,
    tasks: []
  }
  const action = resolveEvidenceMissRecovery({
    taskId: 'm2-s3-t2',
    taskProgress: progress,
    message
  })
  assert.equal(action.action, 'infra-retry')
  if (action.action !== 'infra-retry') return
  assert.equal(action.attempt, 1)
  assert.equal(action.classification.kind, 'infra')

  const withError = resolveTaskInfraRecovery({
    taskId: 'm2-s3-t2',
    taskProgress: progress,
    message,
    error: new Error(message)
  })
  assert.equal(withError.action, 'infra-retry')
})
