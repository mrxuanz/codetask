import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildCodexTurnPlan,
  resolveCodexMcpToolNamesForTurn,
  resolveCodexOuterSandbox
} from '../../src/server/agent-runtime/providers/codex-policy'
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

test('resolveCodexOuterSandbox: every provider role requires outer sandbox', () => {
  assert.equal(resolveCodexOuterSandbox('conversation', undefined), true)
  assert.equal(resolveCodexOuterSandbox('planner', undefined), true)
  assert.equal(resolveCodexOuterSandbox('task-worker', true), true)
  assert.equal(resolveCodexOuterSandbox('slice-verifier', undefined), true)
  assert.equal(resolveCodexOuterSandbox('milestone-verifier', undefined), true)
  assert.throws(
    () => resolveCodexOuterSandbox('conversation', false),
    /cannot disable outer sandbox/
  )
})

test('resolveCodexMcpToolNamesForTurn picks role defaults', () => {
  assert.deepEqual(resolveCodexMcpToolNamesForTurn(baseInput('task-worker')), [
    'report_task_result'
  ])
  assert.deepEqual(resolveCodexMcpToolNamesForTurn(baseInput('planner')), [
    'register_task_context',
    'update_task_context',
    'register_plan'
  ])
  assert.equal(resolveCodexMcpToolNamesForTurn(baseInput('conversation')), undefined)
})

test('buildCodexTurnPlan unifies conversation vs planner vs sandboxed task', () => {
  const conversation = buildCodexTurnPlan(
    { ...baseInput('conversation'), mcpUrl: 'http://127.0.0.1:9/mcp' },
    { outerSandbox: true }
  )
  assert.equal(conversation.outerSandbox, true)
  assert.equal(conversation.threadOptions.sandboxMode, 'danger-full-access')
  assert.equal(conversation.mcpToolNames, undefined)
  assert.ok(
    conversation.sdkConfig?.mcp_servers && 'codeteam-manager' in conversation.sdkConfig.mcp_servers
  )

  const planner = buildCodexTurnPlan(
    { ...baseInput('planner'), mcpUrl: 'http://127.0.0.1:9/mcp' },
    { outerSandbox: true }
  )
  assert.equal(planner.outerSandbox, true)
  assert.ok(planner.mcpToolNames?.includes('register_plan'))

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
  assert.equal(task.env.CODETASK_TASK_IDEMPOTENCY_KEY, 'logical-task-key')
  assert.equal(task.env.CODETASK_TASK_IDEMPOTENCY_SCOPE, 'logical-task')
})

test('buildCodexTurnPlan conversation fallback uses wizard tool union', () => {
  const conversation = buildCodexTurnPlan(
    { ...baseInput('conversation'), mcpUrl: 'http://127.0.0.1:9/mcp' },
    { outerSandbox: true }
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
  assert.ok('rename_thread' in tools)
  assert.ok('list_reference_corpus' in tools)
  assert.ok('propose_task_draft' in tools)
})
