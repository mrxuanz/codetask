import assert from 'node:assert/strict'
import test from 'node:test'
import { createTurnError } from '../../src/shared/turn-errors/turn-error.ts'
import {
  isInfraTurnError,
  isRetryableSandboxError,
  isRetryableTurnError,
  normalizeTurnError
} from '../../src/shared/turn-errors.ts'
import { turnRetryDelayMs } from '../../src/server/agent-runtime/retry'
import { SandboxError } from '../../src/server/sandbox/types'

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

test('isRetryableTurnError treats OpenCode session_error as non-retryable', () => {
  assert.equal(isRetryableTurnError(createTurnError('provider.opencode.session_error')), false)
  // Startup failures remain retryable infra
  assert.equal(isRetryableTurnError(createTurnError('provider.opencode.server_timeout')), true)
  assert.equal(isRetryableTurnError(createTurnError('provider.opencode.server_exited')), true)
})

test('isRetryableTurnError treats OpenCode stream_disconnected / fetch failed as retryable', () => {
  assert.equal(
    isRetryableTurnError(
      createTurnError('provider.opencode.stream_disconnected', { detail: 'fetch failed' })
    ),
    true
  )
  assert.equal(isInfraTurnError(createTurnError('provider.opencode.stream_disconnected')), true)
})

test('isRetryableTurnError does not retry session_error preserved on SandboxError', () => {
  const err = new SandboxError('OpenCode session error', 'provider.opencode.session_error')
  assert.equal(isRetryableTurnError(err), false)
  assert.equal(isRetryableSandboxError(err), false)
  assert.equal(isInfraTurnError(err), false)
  assert.equal(normalizeTurnError(err).code, 'provider.opencode.session_error')
})

test('isRetryableTurnError does not retry session_error wrapped as sandbox.worker.exit', () => {
  // Supervisor exit path previously forced sandbox.worker.exit and blind-retried.
  const withCode = new SandboxError('OpenCode session error', 'provider.opencode.session_error')
  assert.equal(isRetryableTurnError(withCode), false)

  const messageOnly = new SandboxError('OpenCode session error', 'sandbox.worker.exit')
  assert.equal(normalizeTurnError(messageOnly).code, 'provider.opencode.session_error')
  assert.equal(isRetryableTurnError(messageOnly), false)
  assert.equal(isRetryableSandboxError(messageOnly), false)
})

test('isRetryableTurnError still retries opaque sandbox.sdk.error', () => {
  const err = new SandboxError('connection reset by peer', 'sandbox.sdk.error')
  assert.equal(normalizeTurnError(err).code, 'turn.unknown')
  assert.equal(isRetryableTurnError(err), true)
  assert.equal(isRetryableSandboxError(err), true)
})

test('turnRetryDelayMs uses exponential backoff for generic transient errors', () => {
  const error = createTurnError('provider.codex.stream_disconnected')
  assert.equal(turnRetryDelayMs(1, error), 2_000)
  assert.equal(turnRetryDelayMs(2, error), 4_000)
  assert.equal(turnRetryDelayMs(3, error), 8_000)
})
