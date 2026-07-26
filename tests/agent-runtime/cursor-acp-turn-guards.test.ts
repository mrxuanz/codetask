import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertTaskWorkerAcpCompletion,
  isEmptyAcpReply
} from '../../src/server/agent-runtime/cursor-acp/turn-guards'
import { isRetryableTurnError } from '../../src/server/agent-runtime/retry'
import { createTurnError } from '../../src/shared/turn-errors'

test('isEmptyAcpReply treats blank as empty', () => {
  assert.equal(isEmptyAcpReply(''), true)
  assert.equal(isEmptyAcpReply('   '), true)
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
      assert.equal((error as { code?: string }).code, 'provider.cursor.acp_empty_turn')
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
      assert.equal((error as { code?: string }).code, 'provider.cursor.acp_keepalive_timeout')
      return true
    }
  )
})

test('cursor acp guard errors are retryable at CODETASK turn layer', () => {
  assert.equal(isRetryableTurnError(createTurnError('provider.cursor.acp_empty_turn')), true)
  assert.equal(
    isRetryableTurnError(createTurnError('provider.cursor.acp_keepalive_timeout')),
    true
  )
})
