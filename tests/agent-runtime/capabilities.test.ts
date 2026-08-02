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

test('resolves runtime capability profiles (chat / planner / sandbox)', () => {
  assert.equal(
    resolveAgentCapabilityProfile({
      role: 'conversation',
      workspaceAccess: 'exclusive-write'
    }),
    'chat-write'
  )
  assert.equal(
    resolveAgentCapabilityProfile({
      role: 'conversation',
      workspaceAccess: 'live-read'
    }),
    'chat-read'
  )
  assert.equal(resolveAgentCapabilityProfile({ role: 'planner' }), 'planner-read')
  assert.equal(resolveAgentCapabilityProfile({ role: 'task-worker' }), 'task-sandbox')
  assert.equal(resolveAgentCapabilityProfile({ role: 'slice-verifier' }), 'verifier-sandbox')
  assert.equal(resolveAgentCapabilityProfile({ role: 'milestone-verifier' }), 'verifier-sandbox')
})

test('only task and verifier profiles require the outer sandbox', () => {
  assert.equal(capabilityProfileRequiresOuterSandbox('chat-write'), false)
  assert.equal(capabilityProfileRequiresOuterSandbox('chat-read'), false)
  assert.equal(capabilityProfileRequiresOuterSandbox('planner-read'), false)
  assert.equal(capabilityProfileRequiresOuterSandbox('task-sandbox'), true)
  assert.equal(capabilityProfileRequiresOuterSandbox('verifier-sandbox'), true)
})

test('read-only profiles are chat-read and planner-read', () => {
  assert.equal(capabilityProfileIsReadOnly('chat-read'), true)
  assert.equal(capabilityProfileIsReadOnly('planner-read'), true)
  assert.equal(capabilityProfileIsReadOnly('chat-write'), false)
  assert.equal(capabilityProfileIsReadOnly('task-sandbox'), false)
})

test('assertCapabilityProfileMatchesRole rejects mismatches', () => {
  assert.doesNotThrow(() => assertCapabilityProfileMatchesRole('conversation', 'chat-read'))
  assert.throws(() => assertCapabilityProfileMatchesRole('conversation', 'task-sandbox'))
})

test('providerSupportsCapability reflects descriptor profiles', () => {
  assert.equal(typeof providerSupportsCapability('codex', 'chat-read'), 'boolean')
  assert.doesNotThrow(() => assertProviderSupportsCapability('codex', 'chat-read'))
})
