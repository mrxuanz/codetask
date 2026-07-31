import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCursorPermissionHandler } from '../../src/server/agent-runtime/cursor-acp/permissions'
import {
  CursorAcpSessionRouter,
  openCursorAcpSession
} from '../../src/server/agent-runtime/cursor-acp/acp-shared'
import { buildCursorTurnPlan } from '../../src/server/providers/cursor/turn-plan'
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

test('permission handler prefers one-turn grants over persistent grants', async () => {
  const handler = createCursorPermissionHandler()
  const result = await handler({
    params: {
      options: [{ optionId: 'deny-once' }, { optionId: 'allow-once' }, { optionId: 'allow-always' }]
    }
  })

  assert.equal(result.outcome.outcome, 'selected')
  if (result.outcome.outcome === 'selected') {
    assert.equal(result.outcome.optionId, 'allow-once')
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
    params: { options, toolCall: { kind: 'execute', title: 'Run terminal command' } }
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
    params: { options, toolCall: { kind: 'other', title: 'untrusted-local-server' } }
  })
  assert.deepEqual(userMcp, {
    outcome: { outcome: 'selected', optionId: 'deny-once' }
  })

  const systemMcp = await handler({
    params: {
      options,
      toolCall: { kind: 'other', title: 'codeteam-manager propose_task_draft' }
    }
  })
  assert.deepEqual(systemMcp, {
    outcome: { outcome: 'selected', optionId: 'allow-once' }
  })

  // Real Cursor ACP title: server and tool are hyphen-joined, then repeated after ":".
  for (const title of [
    'codeteam-manager-register_plan_outline: register_plan_outline',
    'codeteam-manager-finalize_plan: finalize_plan',
    'codeteam-manager_register_task_context'
  ] as const) {
    const plannerMcp = await handler({
      params: { options, toolCall: { kind: 'other', title } }
    })
    assert.deepEqual(
      plannerMcp,
      { outcome: { outcome: 'selected', optionId: 'allow-once' } },
      title
    )
  }

  const toolNameWithoutServer = await handler({
    params: {
      options,
      toolCall: { kind: 'other', title: 'register_plan_outline' }
    }
  })
  assert.deepEqual(toolNameWithoutServer, {
    outcome: { outcome: 'selected', optionId: 'deny-once' }
  })

  const deceptiveShell = await handler({
    params: {
      options,
      toolCall: { kind: 'execute', title: 'Read package.json with cat' }
    }
  })
  assert.deepEqual(deceptiveShell, {
    outcome: { outcome: 'selected', optionId: 'deny-once' }
  })

  const deceptiveExecuteAsMcp = await handler({
    params: {
      options,
      toolCall: {
        kind: 'execute',
        title: 'codeteam-manager-register_plan_outline: register_plan_outline'
      }
    }
  })
  assert.deepEqual(deceptiveExecuteAsMcp, {
    outcome: { outcome: 'selected', optionId: 'deny-once' }
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
    assert.deepEqual(plan.cliArgs.slice(-3), ['--workspace', '/workspace', 'acp'])
    assert.equal(plan.cliArgs.includes('--approve-mcps'), false)
    assert.equal(plan.mcpServers.length, 1)
    assert.equal(plan.mcpServers[0]?.name, 'codeteam-manager')
    assert.equal(plan.mcpServers[0]?.type, 'http')
  }
})

test('buildCursorTurnPlan: task-worker uses outer sandbox without control env', () => {
  const plan = buildCursorTurnPlan(
    { ...baseInput('task-worker'), idempotencyKey: 'logical-task-key' },
    { outerSandbox: true }
  )
  assert.equal(plan.outerSandbox, true)
  assert.ok(plan.cliArgs.includes('--sandbox'))
  assert.ok(plan.cliArgs.includes('disabled'))
  assert.deepEqual(plan.cliArgs.slice(-3), ['--workspace', '/workspace', 'acp'])
  assert.ok(plan.cliArgs.includes('--approve-mcps'))
  assert.equal('CODETASK_TASK_IDEMPOTENCY_KEY' in plan.env, false)
})

test('Cursor ACP loads sessions only through the advertised public capability and pins cwd', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const ctx = {
    async request(method: string, params: Record<string, unknown>) {
      calls.push({ method, params })
      return {}
    }
  }
  const session = await openCursorAcpSession(
    ctx as never,
    {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true }
    },
    new CursorAcpSessionRouter(),
    '/workspace',
    'existing-session',
    []
  )
  assert.equal(session.sessionId, 'existing-session')
  assert.deepEqual(calls, [
    {
      method: 'session/load',
      params: {
        sessionId: 'existing-session',
        cwd: '/workspace',
        additionalDirectories: [],
        mcpServers: []
      }
    }
  ])
  session.dispose()
})

test('Cursor ACP does not silently replace a failed resumable session', async () => {
  const ctx = {
    async request() {
      throw new Error('cwd mismatch')
    }
  }
  await assert.rejects(
    () =>
      openCursorAcpSession(
        ctx as never,
        {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true }
        },
        new CursorAcpSessionRouter(),
        '/workspace',
        'existing-session',
        []
      ),
    (error: unknown) =>
      error instanceof Error &&
      'detail' in error &&
      /refused to load session.*cwd mismatch/i.test(String((error as { detail?: unknown }).detail))
  )
})
