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
  const handler = createCursorPermissionHandler()

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

test('buildCursorTurnPlan: conversation/planner host identity, no full-access flags', () => {
  for (const role of ['conversation', 'planner'] as const) {
    const plan = buildCursorTurnPlan(
      { ...baseInput(role), mcpUrl: 'http://127.0.0.1:9/mcp' },
      { outerSandbox: false }
    )
    assert.equal(plan.outerSandbox, false)
    assert.deepEqual(plan.cliArgs, ['--approve-mcps', 'acp'])
    assert.equal(plan.mcpServers.length, 1)
    assert.equal(plan.mcpServers[0]?.name, 'codeteam-manager')
    assert.equal(plan.mcpServers[0]?.type, 'http')
  }
})

test('buildCursorTurnPlan: task-worker uses outer sandbox full-access CLI', () => {
  const plan = buildCursorTurnPlan(baseInput('task-worker'), { outerSandbox: true })
  assert.equal(plan.outerSandbox, true)
  assert.ok(plan.cliArgs.includes('--sandbox'))
  assert.ok(plan.cliArgs.includes('disabled'))
  assert.ok(plan.cliArgs.includes('--approve-mcps'))
})
