import assert from 'node:assert/strict'
import test from 'node:test'
import { buildConversationCursorRuntimeScope } from '../../src/server/agent-runtime/cursor-acp/runtime-registry'
import { shouldInvalidateCursorScopedRuntime } from '../../src/server/agent-runtime/cursor-acp/turn-guards'
import { createTurnError, TURN_CANCELLED } from '../../src/shared/turn-errors.ts'

test('shouldInvalidateCursorScopedRuntime keeps conversation process on soft failures', () => {
  const scopeId = buildConversationCursorRuntimeScope('thread-soft', 'chat')

  assert.equal(
    shouldInvalidateCursorScopedRuntime(
      'conversation',
      scopeId,
      createTurnError('provider.cursor.acp_empty_turn')
    ),
    false
  )
  assert.equal(shouldInvalidateCursorScopedRuntime('conversation', scopeId, TURN_CANCELLED), false)
  assert.equal(
    shouldInvalidateCursorScopedRuntime(
      'conversation',
      scopeId,
      createTurnError('provider.cursor.not_authenticated')
    ),
    true
  )
  assert.equal(
    shouldInvalidateCursorScopedRuntime(
      'conversation',
      scopeId,
      createTurnError('provider.cursor.acp_failed', {
        detail: 'Cursor ACP runtime closed'
      })
    ),
    true
  )
})

test('shouldInvalidateCursorScopedRuntime still recycles job scopes on errors', () => {
  assert.equal(
    shouldInvalidateCursorScopedRuntime(
      'task-worker',
      'job-123',
      createTurnError('provider.cursor.acp_empty_turn')
    ),
    true
  )
})
