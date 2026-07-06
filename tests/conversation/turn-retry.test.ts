import assert from 'node:assert/strict'
import test from 'node:test'
import { createTurnError } from '../../src/shared/turn-errors/turn-error.ts'
import { isRetryableTurnError, turnRetryDelayMs } from '../../src/server/agent-runtime/retry'

test('isRetryableTurnError treats network and stream failures as retryable', () => {
  assert.equal(isRetryableTurnError(createTurnError('provider.codex.stream_disconnected')), true)
  assert.equal(isRetryableTurnError(createTurnError('provider.rate_limited')), true)
  assert.equal(
    isRetryableTurnError(createTurnError('sandbox.child_closed', { detail: 'read ECONNRESET' })),
    true
  )
})

test('isRetryableTurnError treats auth and cancel as non-retryable', () => {
  assert.equal(isRetryableTurnError(createTurnError('turn.cancelled')), false)
  assert.equal(
    isRetryableTurnError(Object.assign(new Error('missing key'), { name: 'AbortError' })),
    false
  )
  assert.equal(isRetryableTurnError(createTurnError('provider.cli_auth_failed')), false)
  assert.equal(isRetryableTurnError(createTurnError('provider.codex.config_invalid')), false)
})

test('isRetryableTurnError retries model capacity with long backoff tier', () => {
  const capacity = createTurnError('turn.capacity_limited')
  assert.equal(isRetryableTurnError(capacity), true)
  assert.equal(turnRetryDelayMs(1, capacity), 30_000)
  assert.equal(turnRetryDelayMs(2, capacity), 60_000)
})

test('isRetryableTurnError treats Cursor ACP authenticate failure as retryable infra', () => {
  assert.equal(
    isRetryableTurnError(
      createTurnError('provider.cursor.acp_authenticate_failed', { detail: 'Internal error' })
    ),
    true
  )
  assert.equal(isRetryableTurnError(createTurnError('sandbox.child_closed')), true)
  assert.equal(isRetryableTurnError(createTurnError('turn.tool_aborted')), true)
})

test('isRetryableTurnError treats Cursor ACP keepalive failures as retryable', () => {
  assert.equal(isRetryableTurnError(createTurnError('provider.cursor.acp_keepalive_timeout')), true)
  assert.equal(isRetryableTurnError(createTurnError('provider.cursor.acp_failed')), true)
})

test('turnRetryDelayMs uses exponential backoff for generic transient errors', () => {
  const error = createTurnError('provider.codex.stream_disconnected')
  assert.equal(turnRetryDelayMs(1, error), 2_000)
  assert.equal(turnRetryDelayMs(2, error), 4_000)
  assert.equal(turnRetryDelayMs(3, error), 8_000)
})
