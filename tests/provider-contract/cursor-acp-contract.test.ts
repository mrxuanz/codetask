import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCursorPermissionHandler } from '../../src/server/agent-runtime/cursor-acp/permissions'
import { buildCursorTurnPlan } from '../../src/server/agent-runtime/providers/cursor-policy'
import type { AgentTurnInput } from '../../src/server/agent-runtime/types'

const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-cursor-acp-'))

test.after(() => {
  rmSync(runtimeRoot, { recursive: true, force: true })
})

function baseInput(role: AgentTurnInput['role']): AgentTurnInput {
  return {
    provider: 'cursorcli',
    role,
    cwd: '/workspace',
    runtimeRoot,
    prompt: 'hi'
  }
}

test('permission handler prefers allow-always over allow-once', async () => {
  const handler = createCursorPermissionHandler()
  const result = await handler({
    params: {
      options: [{ optionId: 'deny-once' }, { optionId: 'allow-once' }, { optionId: 'allow-always' }]
    }
  })

  assert.equal(result.outcome.outcome, 'selected')
  if (result.outcome.outcome === 'selected') {
    assert.equal(result.outcome.optionId, 'allow-always')
  }
})

test('permission handler auto-approves write, shell, and MCP prompts', async () => {
  const handler = createCursorPermissionHandler('chat-write')

  for (const kind of ['write', 'shell', 'mcp'] as const) {
    const result = await handler({
      params: {
        options: [{ optionId: 'deny-once' }, { optionId: 'allow-once' }]
      }
    })

    assert.equal(result.outcome.outcome, 'selected')
    if (result.outcome.outcome === 'selected') {
      assert.equal(result.outcome.optionId, 'allow-once', kind)
    }
  }
})

test('permission handler denies shell/write for read-only profiles and permits reads', async () => {
  const handler = createCursorPermissionHandler('planner-read')
  const options = [{ optionId: 'deny-once' }, { optionId: 'allow-once' }]

  const denied = await handler({
    params: { options, toolCall: { kind: 'shell', title: 'Run terminal command' } }
  })
  assert.deepEqual(denied, {
    outcome: { outcome: 'selected', optionId: 'deny-once' }
  })

  const allowed = await handler({
    params: { options, toolCall: { kind: 'read', title: 'Read file' } }
  })
  assert.deepEqual(allowed, {
    outcome: { outcome: 'selected', optionId: 'allow-once' }
  })

  const userMcp = await handler({
    params: { options, toolCall: { kind: 'mcp', title: 'untrusted-local-server' } }
  })
  assert.deepEqual(userMcp, {
    outcome: { outcome: 'selected', optionId: 'deny-once' }
  })

  const systemMcp = await handler({
    params: { options, toolCall: { kind: 'mcp', title: 'codeteam-manager' } }
  })
  assert.deepEqual(systemMcp, {
    outcome: { outcome: 'selected', optionId: 'allow-once' }
  })
})

test('buildCursorTurnPlan: conversation/planner run directly with scoped MCP', () => {
  for (const [role, capabilityProfile] of [
    ['conversation', 'create-task-read'],
    ['planner', 'planner-read']
  ] as const) {
    const plan = buildCursorTurnPlan(
      { ...baseInput(role), capabilityProfile, mcpUrl: 'http://127.0.0.1:9/mcp' },
      { outerSandbox: false }
    )
    assert.equal(plan.outerSandbox, false)
    assert.equal(plan.capabilityProfile, capabilityProfile)
    assert.equal(plan.cliArgs.includes('--sandbox'), false)
    assert.deepEqual(plan.cliArgs.slice(0, 2), ['--mode', 'ask'])
    assert.equal(plan.cliArgs.includes('--approve-mcps'), false)
    assert.equal(plan.mcpServers.length, 1)
    assert.equal(plan.mcpServers[0]?.name, 'codeteam-manager')
    assert.equal(plan.mcpServers[0]?.type, 'http')
  }
})

test('buildCursorTurnPlan: task-worker uses outer sandbox full-access CLI and key', () => {
  const plan = buildCursorTurnPlan(
    { ...baseInput('task-worker'), idempotencyKey: 'logical-task-key' },
    { outerSandbox: true }
  )
  assert.equal(plan.outerSandbox, true)
  assert.ok(plan.cliArgs.includes('--sandbox'))
  assert.ok(plan.cliArgs.includes('disabled'))
  assert.ok(plan.cliArgs.includes('--approve-mcps'))
  assert.equal(plan.env.CODETASK_TASK_IDEMPOTENCY_KEY, 'logical-task-key')
})
