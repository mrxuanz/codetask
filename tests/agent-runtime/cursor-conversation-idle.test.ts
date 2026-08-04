import assert from 'node:assert/strict'
import test from 'node:test'
import {
  listConversationCursorBindings,
  parseConversationCursorScope,
  resetConversationCursorDirectoryForTests,
  upsertConversationCursorBinding
} from '../../packages/provider-runtime-node/src/cursor-acp/conversation-cursor-directory'
import { buildConversationProviderRuntimeScopeId } from '../../src/shared/providers/capabilities'

test('buildConversationProviderRuntimeScopeId uses stable conversation id (03)', () => {
  assert.equal(
    buildConversationProviderRuntimeScopeId('conversation-abc', 'chat'),
    'conversation:conversation-abc'
  )
})

test('parseConversationCursorScope accepts canonical and legacy chat scopes', () => {
  assert.deepEqual(parseConversationCursorScope('conversation:abc'), {
    conversationId: 'abc',
    kind: 'chat'
  })
  assert.deepEqual(parseConversationCursorScope('conversation:abc:provider:cursor'), {
    conversationId: 'abc',
    kind: 'chat'
  })
  assert.deepEqual(parseConversationCursorScope('conversation:chat:abc'), {
    conversationId: 'abc',
    kind: 'chat'
  })
  assert.equal(parseConversationCursorScope('conversation:create_task:abc'), null)
})

test('upsertConversationCursorBinding tracks chat scopes only', () => {
  resetConversationCursorDirectoryForTests()
  const binding = upsertConversationCursorBinding('conversation:conversation-bind:provider:cursor')
  assert.ok(binding)
  assert.equal(binding.conversationId, 'conversation-bind')
  assert.equal(binding.kind, 'chat')
  assert.equal(listConversationCursorBindings().length, 1)
  assert.equal(upsertConversationCursorBinding('conversation:create_task:x'), null)
})
