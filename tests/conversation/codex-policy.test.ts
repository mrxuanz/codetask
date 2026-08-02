import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildCodexTurnPlan,
  resolveCodexMcpToolNamesForTurn,
  resolveCodexOuterSandbox
} from '../../src/server/providers/codex/turn-plan.ts'
import { applyLoopbackNoProxyEnv } from '../../src/server/agent-runtime/env'
import {
  resolveCodexConfigTurnError,
  resolveCodexMcpStartupTurnError
} from '../../src/server/agent-runtime/providers/codex-sdk'
import type { AgentTurnInput } from '../../src/server/agent-runtime/types'

const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-codex-policy-'))

test.after(() => {
  rmSync(runtimeRoot, { recursive: true, force: true })
})

function baseInput(role: AgentTurnInput['role']): AgentTurnInput {
  return {
    provider: 'codex',
    role,
    cwd: '/workspace',
    runtimeRoot,
    prompt: 'hi'
  }
}

test('resolveCodexOuterSandbox: only execution roles require outer sandbox', () => {
  assert.equal(resolveCodexOuterSandbox('conversation', undefined), false)
  assert.equal(resolveCodexOuterSandbox('planner', undefined), false)
  assert.equal(resolveCodexOuterSandbox('task-worker', true), true)
  assert.equal(resolveCodexOuterSandbox('slice-verifier', undefined), true)
  assert.equal(resolveCodexOuterSandbox('milestone-verifier', undefined), true)
  assert.equal(resolveCodexOuterSandbox('conversation', false), false)
})

test('resolveCodexMcpToolNamesForTurn picks role defaults', () => {
  assert.deepEqual(resolveCodexMcpToolNamesForTurn(baseInput('task-worker')), [
    'report_task_result'
  ])
  assert.equal(resolveCodexMcpToolNamesForTurn(baseInput('planner')), undefined)
  assert.equal(resolveCodexMcpToolNamesForTurn(baseInput('conversation')), undefined)
})

test('buildCodexTurnPlan unifies conversation vs planner vs sandboxed task', () => {
  const conversation = buildCodexTurnPlan(
    {
      ...baseInput('conversation'),
      capabilityProfile: 'chat-write',
      mcpUrl: 'http://127.0.0.1:9/mcp'
    },
    { outerSandbox: false }
  )
  assert.equal(conversation.outerSandbox, false)
  assert.equal(conversation.threadOptions.sandboxMode, 'workspace-write')
  assert.equal(conversation.threadOptions.additionalDirectories, undefined)
  assert.equal(conversation.mcpToolNames, undefined)
  assert.ok(
    conversation.sdkConfig?.mcp_servers && 'codeteam-manager' in conversation.sdkConfig.mcp_servers
  )
  const systemMcp = conversation.sdkConfig?.mcp_servers?.['codeteam-manager'] as
    | { required?: boolean }
    | undefined
  assert.equal(systemMcp?.required, true)
  for (const entry of ['127.0.0.1', 'localhost', '::1']) {
    assert.ok(conversation.env.NO_PROXY.split(',').includes(entry))
    assert.ok(conversation.env.no_proxy.split(',').includes(entry))
  }

  const planner = buildCodexTurnPlan(
    {
      ...baseInput('planner'),
      capabilityProfile: 'planner-read',
      mcpUrl: 'http://127.0.0.1:9/mcp'
    },
    { outerSandbox: false }
  )
  assert.equal(planner.outerSandbox, false)
  assert.equal(planner.threadOptions.sandboxMode, 'read-only')
  assert.equal(planner.threadOptions.networkAccessEnabled, false)
  assert.equal(planner.mcpToolNames, undefined)

  const task = buildCodexTurnPlan(
    {
      ...baseInput('task-worker'),
      mcpUrl: 'http://127.0.0.1:9/mcp',
      idempotencyKey: 'logical-task-key'
    },
    { outerSandbox: true }
  )
  assert.equal(task.outerSandbox, true)
  assert.equal(task.threadOptions.sandboxMode, 'danger-full-access')
  assert.equal(task.sdkConfig?.sandbox_mode, 'danger-full-access')
  assert.ok(task.mcpToolNames?.includes('report_task_result'))
  assert.equal('CODETASK_TASK_IDEMPOTENCY_KEY' in task.env, false)
  assert.equal('CODETASK_TASK_IDEMPOTENCY_SCOPE' in task.env, false)
})

test('applyLoopbackNoProxyEnv preserves inherited entries and synchronizes both casings', () => {
  const env = {
    NO_PROXY: 'example.test, localhost',
    no_proxy: 'internal.test,127.0.0.1'
  }

  applyLoopbackNoProxyEnv(env)

  const expected = 'example.test,localhost,internal.test,127.0.0.1,::1'
  assert.equal(env.NO_PROXY, expected)
  assert.equal(env.no_proxy, expected)
})

test('resolveCodexMcpStartupTurnError maps required system MCP startup failures by role', () => {
  const failure = new Error(
    'MCP startup failed: required MCP servers failed to initialize: codeteam-manager'
  )

  assert.equal(
    resolveCodexMcpStartupTurnError({ role: 'planner', mcpUrl: 'http://127.0.0.1:9/mcp' }, failure)
      ?.code,
    'plan.mcp_unavailable'
  )
  assert.equal(
    resolveCodexMcpStartupTurnError(
      { role: 'conversation', mcpUrl: 'http://127.0.0.1:9/mcp' },
      failure
    )?.code,
    'conversation.mcp_unavailable'
  )
  assert.equal(
    resolveCodexMcpStartupTurnError({ role: 'planner', mcpUrl: undefined }, failure),
    null
  )
  assert.equal(
    resolveCodexMcpStartupTurnError(
      { role: 'planner', mcpUrl: 'http://127.0.0.1:9/mcp' },
      new Error('model overloaded')
    ),
    null
  )
})

test('Codex config failures are classified from the SDK runtime that actually launched', () => {
  assert.equal(
    resolveCodexConfigTurnError(new Error('Failed to load configuration: invalid TOML at line 3'))
      ?.code,
    'provider.codex.config_invalid'
  )
  assert.equal(
    resolveCodexConfigTurnError(new Error('config.toml parse error near model_provider'))?.code,
    'provider.codex.config_invalid'
  )
  assert.equal(resolveCodexConfigTurnError(new Error('model overloaded')), null)
})

test('buildCodexTurnPlan conversation MCP exposes chat attachment tools only (03)', () => {
  const conversation = buildCodexTurnPlan(
    {
      ...baseInput('conversation'),
      capabilityProfile: 'chat-read',
      mcpUrl: 'http://127.0.0.1:9/mcp'
    },
    { outerSandbox: false }
  )
  const tools =
    conversation.sdkConfig?.mcp_servers && 'codeteam-manager' in conversation.sdkConfig.mcp_servers
      ? (
          conversation.sdkConfig.mcp_servers['codeteam-manager'] as {
            tools?: Record<string, unknown>
          }
        ).tools
      : undefined
  assert.ok(tools)
  assert.ok('read_reference_attachment' in tools)
  assert.equal('propose_task_draft' in tools, false)
  assert.equal('list_reference_corpus' in tools, false)
})
