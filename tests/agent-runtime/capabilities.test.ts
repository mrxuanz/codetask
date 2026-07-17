import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertCapabilityProfileMatchesRole,
  assertProviderSupportsCapability,
  capabilityProfileIsReadOnly,
  capabilityProfileRequiresOuterSandbox,
  providerSupportsCapability,
  resolveAgentCapabilityProfile
} from '../../src/server/agent-runtime/capabilities'

test('resolves the six runtime capability profiles', () => {
  assert.equal(
    resolveAgentCapabilityProfile({
      role: 'conversation',
      conversationKind: 'chat',
      workspaceAccess: 'exclusive-write'
    }),
    'chat-write'
  )
  assert.equal(
    resolveAgentCapabilityProfile({
      role: 'conversation',
      conversationKind: 'chat',
      workspaceAccess: 'live-read'
    }),
    'chat-read'
  )
  assert.equal(
    resolveAgentCapabilityProfile({
      role: 'conversation',
      conversationKind: 'create_task',
      workspaceAccess: 'live-read'
    }),
    'create-task-read'
  )
  assert.equal(resolveAgentCapabilityProfile({ role: 'planner' }), 'planner-read')
  assert.equal(resolveAgentCapabilityProfile({ role: 'task-worker' }), 'task-sandbox')
  assert.equal(resolveAgentCapabilityProfile({ role: 'slice-verifier' }), 'verifier-sandbox')
  assert.equal(resolveAgentCapabilityProfile({ role: 'milestone-verifier' }), 'verifier-sandbox')
})

test('only task and verifier profiles require the outer sandbox', () => {
  assert.equal(capabilityProfileRequiresOuterSandbox('chat-write'), false)
  assert.equal(capabilityProfileRequiresOuterSandbox('chat-read'), false)
  assert.equal(capabilityProfileRequiresOuterSandbox('create-task-read'), false)
  assert.equal(capabilityProfileRequiresOuterSandbox('planner-read'), false)
  assert.equal(capabilityProfileRequiresOuterSandbox('task-sandbox'), true)
  assert.equal(capabilityProfileRequiresOuterSandbox('verifier-sandbox'), true)
})

test('strict read-only provider support fails closed', () => {
  assert.equal(capabilityProfileIsReadOnly('planner-read'), true)
  assert.equal(providerSupportsCapability('claude-code', 'planner-read'), true)
  assert.equal(providerSupportsCapability('cursorcli', 'chat-read'), true)
  assert.equal(providerSupportsCapability('opencode', 'create-task-read'), true)
  assert.equal(providerSupportsCapability('codex', 'planner-read'), false)
  assert.throws(
    () => assertProviderSupportsCapability('codex', 'planner-read'),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'provider.capability_unsupported'
  )
  assert.doesNotThrow(() => assertProviderSupportsCapability('codex', 'chat-write'))
  assert.doesNotThrow(() => assertProviderSupportsCapability('codex', 'task-sandbox'))
})

test('role/profile combinations cannot bypass sandbox routing', () => {
  assert.doesNotThrow(() =>
    assertCapabilityProfileMatchesRole('conversation', 'chat-write')
  )
  assert.doesNotThrow(() =>
    assertCapabilityProfileMatchesRole('conversation', 'create-task-read')
  )
  assert.doesNotThrow(() =>
    assertCapabilityProfileMatchesRole('task-worker', 'task-sandbox')
  )
  assert.throws(
    () => assertCapabilityProfileMatchesRole('task-worker', 'chat-write'),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'provider.capability_unsupported'
  )
  assert.throws(() =>
    assertCapabilityProfileMatchesRole('planner', 'verifier-sandbox')
  )
})
