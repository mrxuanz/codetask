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

test('resolveCodexOuterSandbox: conversation off, task/verifier on', () => {
  assert.equal(resolveCodexOuterSandbox('conversation', false), false)
  assert.equal(resolveCodexOuterSandbox('planner', false), false)
  assert.equal(resolveCodexOuterSandbox('task-worker', true), true)
  assert.equal(resolveCodexOuterSandbox('slice-verifier', undefined), true)
  assert.equal(resolveCodexOuterSandbox('milestone-verifier', undefined), true)
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
    { outerSandbox: false }
  )
  assert.equal(conversation.outerSandbox, false)
  assert.equal(conversation.threadOptions.sandboxMode, 'workspace-write')
  assert.equal(conversation.mcpToolNames, undefined)
  assert.ok(
    conversation.sdkConfig?.mcp_servers && 'codeteam-manager' in conversation.sdkConfig.mcp_servers
  )

  const planner = buildCodexTurnPlan(
    { ...baseInput('planner'), mcpUrl: 'http://127.0.0.1:9/mcp' },
    { outerSandbox: false }
  )
  assert.equal(planner.outerSandbox, false)
  assert.ok(planner.mcpToolNames?.includes('register_plan'))

  const task = buildCodexTurnPlan(
    { ...baseInput('task-worker'), mcpUrl: 'http://127.0.0.1:9/mcp' },
    { outerSandbox: true }
  )
  assert.equal(task.outerSandbox, true)
  assert.equal(task.threadOptions.sandboxMode, 'danger-full-access')
  assert.equal(task.sdkConfig?.sandbox_mode, 'danger-full-access')
  assert.ok(task.mcpToolNames?.includes('report_task_result'))
})
