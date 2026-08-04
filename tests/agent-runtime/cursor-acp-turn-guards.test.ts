import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertCursorAcpCompletion,
  isEmptyAcpReply,
  stderrIndicatesCursorCloudFailure
} from '../../src/server/agent-runtime/cursor-acp/turn-guards'
import { isRetryableTurnError } from '../../src/server/agent-runtime/retry'
import {
  createTurnError,
  indicatesCursorProviderCapacity,
  normalizeTurnError
} from '../../src/shared/turn-errors'

test('isEmptyAcpReply treats blank as empty', () => {
  assert.equal(isEmptyAcpReply(''), true)
  assert.equal(isEmptyAcpReply('   '), true)
  assert.equal(isEmptyAcpReply('done'), false)
})

test('assertCursorAcpCompletion rejects empty task-worker turn', () => {
  assert.throws(
    () =>
      assertCursorAcpCompletion({
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

test('assertCursorAcpCompletion allows conversation empty reply', () => {
  assert.doesNotThrow(() =>
    assertCursorAcpCompletion({
      role: 'conversation',
      reply: '',
      stderrTail: '',
      promptSettledError: null
    })
  )
})

test('assertCursorAcpCompletion allows planner empty reply without cloud failure', () => {
  assert.doesNotThrow(() =>
    assertCursorAcpCompletion({
      role: 'planner',
      reply: '',
      stderrTail: '',
      promptSettledError: null
    })
  )
})

test('assertCursorAcpCompletion rejects keepalive signal in stderr for task-worker', () => {
  assert.throws(
    () =>
      assertCursorAcpCompletion({
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

test('assertCursorAcpCompletion rejects resource_exhausted for planner', () => {
  assert.throws(
    () =>
      assertCursorAcpCompletion({
        role: 'planner',
        reply: '',
        stderrTail: 'ConnectError: [resource_exhausted] Unable to reach the model provider',
        promptSettledError: null
      }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'turn.capacity_limited')
      return true
    }
  )
})

test('stderrIndicatesCursorCloudFailure covers capacity and keepalive', () => {
  assert.equal(
    stderrIndicatesCursorCloudFailure(
      'ConnectError: [resource_exhausted] Unable to reach the model provider'
    ),
    true
  )
  assert.equal(
    stderrIndicatesCursorCloudFailure('RetriableError: HTTP/2 keepalive ping timed out'),
    true
  )
  assert.equal(stderrIndicatesCursorCloudFailure('normal agent log line'), false)
})

test('normalizeTurnError maps resource_exhausted ConnectError to capacity_limited', () => {
  const dto = normalizeTurnError(
    new Error('ConnectError: [resource_exhausted] Unable to reach the model provider')
  )
  assert.equal(dto.code, 'turn.capacity_limited')
  assert.equal(indicatesCursorProviderCapacity(dto.detail ?? ''), true)
})

test('cursor acp guard errors are retryable at CODETASK turn layer', () => {
  assert.equal(isRetryableTurnError(createTurnError('provider.cursor.acp_empty_turn')), true)
  assert.equal(isRetryableTurnError(createTurnError('provider.cursor.acp_keepalive_timeout')), true)
  assert.equal(isRetryableTurnError(createTurnError('turn.capacity_limited')), true)
  assert.equal(isRetryableTurnError(createTurnError('turn.incomplete')), true)
})
