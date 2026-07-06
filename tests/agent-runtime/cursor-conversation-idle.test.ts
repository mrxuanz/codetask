import assert from 'node:assert/strict'
import test from 'node:test'
import {
  listConversationCursorBindings,
  resetConversationCursorDirectoryForTests,
  upsertConversationCursorBinding
} from '../../src/server/agent-runtime/cursor-acp/conversation-cursor-directory'
import {
  DEFAULT_INACTIVITY_THRESHOLD_MS,
  stopConversationCursorReaperForTests,
  sweepConversationCursorSessions
} from '../../src/server/agent-runtime/cursor-acp/conversation-cursor-reaper'
import {
  buildConversationCursorRuntimeScope,
  buildCursorRuntimeKey,
  getCursorProviderRuntimeRegistry,
  isConversationCursorScope,
  resetCursorProviderRuntimeRegistryForTests
} from '../../src/server/agent-runtime/cursor-acp/runtime-registry'

test.after(() => {
  stopConversationCursorReaperForTests()
})

test('buildConversationCursorRuntimeScope separates chat and create_task', () => {
  const threadId = 'thread-abc'
  assert.equal(
    buildConversationCursorRuntimeScope(threadId, 'chat'),
    'conversation:chat:thread-abc'
  )
  assert.equal(
    buildConversationCursorRuntimeScope(threadId, 'create_task'),
    'conversation:create_task:thread-abc'
  )
})

test('isConversationCursorScope recognizes conversation scopes', () => {
  assert.equal(isConversationCursorScope('conversation:chat:thread-1'), true)
  assert.equal(isConversationCursorScope('conversation:create_task:thread-1'), true)
  assert.equal(isConversationCursorScope('job-123'), false)
})

test('buildCursorRuntimeKey ignores mcpProfile for conversation scopes', () => {
  const scopeId = buildConversationCursorRuntimeScope('thread-mcp', 'chat')
  const base = {
    scopeId,
    provider: 'cursorcli',
    workspaceRoot: '/workspace',
    model: 'auto'
  }
  assert.equal(
    buildCursorRuntimeKey({ ...base, mcpProfile: 'none' }),
    buildCursorRuntimeKey({ ...base, mcpProfile: 'http://127.0.0.1:8080/mcp' })
  )
  assert.notEqual(
    buildCursorRuntimeKey({ ...base, mcpProfile: 'none' }),
    buildCursorRuntimeKey({
      scopeId: 'job-abc',
      provider: 'cursorcli',
      workspaceRoot: '/workspace',
      model: 'auto',
      mcpProfile: 'none'
    })
  )
})

test('sweepConversationCursorSessions reaps idle bindings like t3code reaper', async () => {
  resetConversationCursorDirectoryForTests()
  resetCursorProviderRuntimeRegistryForTests()

  const scopeId = buildConversationCursorRuntimeScope('thread-idle', 'chat')
  upsertConversationCursorBinding(scopeId)

  const binding = listConversationCursorBindings().find((item) => item.scopeId === scopeId)
  assert.ok(binding)
  binding!.lastSeenAt = Date.now() - DEFAULT_INACTIVITY_THRESHOLD_MS - 1

  const registry = getCursorProviderRuntimeRegistry()
  const closed = { value: false }
  const runtime = {
    isClosed: () => false,
    isPromptInFlight: () => false,
    close: async () => {
      closed.value = true
    }
  }
  ;(registry as unknown as { entries: Map<string, unknown> }).entries.set('test-key', {
    key: 'test-key',
    scopeId,
    runtime,
    lastUsedAt: binding!.lastSeenAt
  })

  const reaped = await sweepConversationCursorSessions({
    inactivityThresholdMs: 1000,
    isThreadInflight: () => false
  })

  assert.equal(reaped, 1)
  assert.equal(closed.value, true)
  assert.equal(
    listConversationCursorBindings().find((item) => item.scopeId === scopeId)?.status,
    'stopped'
  )
})

test('sweepConversationCursorSessions skips inflight threads', async () => {
  resetConversationCursorDirectoryForTests()

  const scopeId = buildConversationCursorRuntimeScope('thread-active', 'create_task')
  upsertConversationCursorBinding(scopeId)
  const binding = listConversationCursorBindings().find((item) => item.scopeId === scopeId)
  binding!.lastSeenAt = Date.now() - DEFAULT_INACTIVITY_THRESHOLD_MS - 1

  const reaped = await sweepConversationCursorSessions({
    inactivityThresholdMs: 1000,
    isThreadInflight: (threadId) => threadId === 'thread-active'
  })

  assert.equal(reaped, 0)
  assert.equal(binding!.status, 'running')
})
