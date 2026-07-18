import assert from 'node:assert/strict'
import test from 'node:test'
import { SUPPORTED_CORE_CODES } from '../../src/server/conversation/cores'
import {
  buildCursorAcpCliArgs,
  resolveProviderOuterSandbox,
  resolveProviderRunPolicy
} from '../../src/server/agent-runtime/provider-policy'
import {
  resolveRoleMcpToolNames,
  type ConversationRole
} from '../../src/server/agent-runtime/roles'

const ROLES: ConversationRole[] = [
  'conversation',
  'planner',
  'task-worker',
  'slice-verifier',
  'milestone-verifier'
]

test('resolveProviderRunPolicy uses runtime-copy inside outer sandbox', () => {
  const policy = resolveProviderRunPolicy({
    outerSandbox: true,
    runtimeRoot: '/tmp/runtime'
  })
  assert.equal(policy.innerAccess, 'full-access')
  assert.equal(policy.approvals, 'auto')
  assert.equal(policy.authMode, 'runtime-copy')
  assert.equal(policy.stateRoot, '/tmp/runtime')
})

test('resolveProviderOuterSandbox matrix', () => {
  assert.equal(resolveProviderOuterSandbox('conversation', undefined), false)
  assert.equal(resolveProviderOuterSandbox('planner', undefined), false)
  assert.equal(resolveProviderOuterSandbox('task-worker', undefined), true)
  assert.equal(resolveProviderOuterSandbox('slice-verifier', undefined), true)
  assert.equal(resolveProviderOuterSandbox('milestone-verifier', undefined), true)
})

test('resolveProviderOuterSandbox rejects disable for file roles', () => {
  for (const role of ['task-worker', 'slice-verifier', 'milestone-verifier'] as const) {
    assert.throws(() => resolveProviderOuterSandbox(role, false), /cannot disable outer sandbox/)
  }
  assert.equal(resolveProviderOuterSandbox('conversation', false), false)
  assert.equal(resolveProviderOuterSandbox('planner', false), false)
})

test('resolveRoleMcpToolNames per role', () => {
  assert.equal(resolveRoleMcpToolNames('conversation'), undefined)
  assert.deepEqual(resolveRoleMcpToolNames('planner'), [
    'register_plan_outline',
    'register_task_context',
    'update_task_context',
    'finalize_plan'
  ])
  assert.deepEqual(resolveRoleMcpToolNames('task-worker'), ['report_task_result'])
  assert.deepEqual(resolveRoleMcpToolNames('slice-verifier'), ['complete_slice_verification'])
  assert.deepEqual(resolveRoleMcpToolNames('milestone-verifier'), [
    'complete_milestone_verification'
  ])
})

test('buildCursorAcpCliArgs sandbox matrix', () => {
  assert.deepEqual(buildCursorAcpCliArgs({ outerSandbox: false }), ['--approve-mcps', 'acp'])
  assert.deepEqual(
    buildCursorAcpCliArgs({
      outerSandbox: true,
      cwd: '/workspace/proj'
    }),
    [
      '--trust',
      '--force',
      '--sandbox',
      'disabled',
      '--approve-mcps',
      '--workspace',
      '/workspace/proj',
      'acp'
    ]
  )
})

test('all supported providers are covered by contract matrix', () => {
  assert.deepEqual([...SUPPORTED_CORE_CODES].sort(), [
    'claude-code',
    'codex',
    'cursorcli',
    'opencode'
  ])
  for (const provider of SUPPORTED_CORE_CODES) {
    for (const role of ROLES) {
      const outer = resolveProviderOuterSandbox(role, undefined)
      assert.equal(typeof outer, 'boolean', `${provider}/${role}`)
    }
  }
})
