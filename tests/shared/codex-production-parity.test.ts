import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { CODEX_DESCRIPTOR } from '../../src/shared/providers/descriptors/codex.ts'
import { DEFAULT_PROVIDERS_CONFIG } from '../../src/shared/providers/settings.ts'
import type { AgentTurnInput } from '../../src/server/agent-runtime/types.ts'
import { createProviderRegistry } from '../../src/server/providers/composition.ts'
import { buildCodexTurnPlan } from '../../src/server/providers/codex/turn-plan.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

function readSource(relativePath: string): string {
  return readFileSync(join(root, relativePath), 'utf8')
}

function baseInput(role: AgentTurnInput['role'], runtimeRoot: string): AgentTurnInput {
  return {
    provider: 'codex',
    role,
    cwd: '/workspace',
    runtimeRoot,
    prompt: 'parity',
    model: 'gpt-test-model'
  }
}

function planSnapshot(plan: ReturnType<typeof buildCodexTurnPlan>): Record<string, unknown> {
  return {
    outerSandbox: plan.outerSandbox,
    sandboxMode: plan.threadOptions.sandboxMode,
    networkAccessEnabled: plan.threadOptions.networkAccessEnabled,
    approvalPolicy: plan.threadOptions.approvalPolicy,
    model: plan.threadOptions.model,
    mcpToolNames: plan.mcpToolNames ? [...plan.mcpToolNames].sort() : null,
    sdkSandboxMode: plan.sdkConfig?.sandbox_mode ?? null,
    hasSystemMcp: Boolean(
      plan.sdkConfig?.mcp_servers && 'codeteam-manager' in plan.sdkConfig.mcp_servers
    ),
    systemMcpRequired: Boolean(
      (plan.sdkConfig?.mcp_servers?.['codeteam-manager'] as { required?: boolean } | undefined)
        ?.required
    )
  }
}

test('production Codex streamCodexTurn routes through getAgentTurnProvider / RuntimeManager', () => {
  const indexSource = readSource('src/server/agent-runtime/providers/index.ts')
  assert.match(indexSource, /getAgentTurnProvider\('codex'\)\.streamTurn/)
  assert.doesNotMatch(indexSource, /streamCodexTurn[\s\S]*await import\('\.\/codex-sdk'\)/)
})

test('role-worker-codex production entry uses Registry CodexDriver', () => {
  const worker = readSource('src/sandbox/role-worker-codex.ts')
  assert.match(worker, /getAgentTurnProvider\('codex'\)/)
  assert.doesNotMatch(worker, /providers\/codex-sdk/)
})

test('sandbox orchestrator uses CodexDriver.preflight for Codex', () => {
  const orchestrator = readSource('src/server/sandbox/orchestrator-local.ts')
  assert.match(orchestrator, /getProviderRegistry\(\)\.get\(input\.coreCode\)/)
  assert.match(orchestrator, /driver\.preflight/)
  assert.match(orchestrator, /contributeSandboxPolicy/)
})

test('Codex registry production driver matches descriptor and settings slot', () => {
  const registry = createProviderRegistry(DEFAULT_PROVIDERS_CONFIG)
  const driver = registry.get('codex')
  assert.equal(driver.kind, 'production')
  assert.equal(driver.descriptor, CODEX_DESCRIPTOR)
  assert.equal(driver.settings, DEFAULT_PROVIDERS_CONFIG.codex)
  assert.equal(driver.descriptor.capabilities.protocol, 'sdk')
  assert.equal(driver.descriptor.capabilities.authMode, 'runtime-copy')
})

test('Codex turn plan parity snapshots stay stable for model/MCP/permissions', () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'cctask-codex-parity-'))
  try {
    const conversation = planSnapshot(
      buildCodexTurnPlan(
        {
          ...baseInput('conversation', runtimeRoot),
          capabilityProfile: 'chat-write',
          mcpUrl: 'http://127.0.0.1:9/mcp'
        },
        { outerSandbox: false }
      )
    )
    const planner = planSnapshot(
      buildCodexTurnPlan(
        {
          ...baseInput('planner', runtimeRoot),
          capabilityProfile: 'planner-read',
          mcpUrl: 'http://127.0.0.1:9/mcp'
        },
        { outerSandbox: false }
      )
    )
    const task = planSnapshot(
      buildCodexTurnPlan(
        {
          ...baseInput('task-worker', runtimeRoot),
          mcpUrl: 'http://127.0.0.1:9/mcp',
          idempotencyKey: 'logical-task-key'
        },
        { outerSandbox: true }
      )
    )

    assert.deepEqual(conversation, {
      outerSandbox: false,
      sandboxMode: 'danger-full-access',
      networkAccessEnabled: true,
      approvalPolicy: 'never',
      model: 'gpt-test-model',
      mcpToolNames: null,
      sdkSandboxMode: null,
      hasSystemMcp: true,
      systemMcpRequired: true
    })
    assert.deepEqual(planner, {
      outerSandbox: false,
      sandboxMode: 'read-only',
      networkAccessEnabled: false,
      approvalPolicy: 'never',
      model: 'gpt-test-model',
      mcpToolNames: [
        'finalize_plan',
        'register_plan_outline',
        'register_task_context',
        'update_task_context'
      ].sort(),
      sdkSandboxMode: null,
      hasSystemMcp: true,
      systemMcpRequired: true
    })
    assert.deepEqual(task, {
      outerSandbox: true,
      sandboxMode: 'danger-full-access',
      networkAccessEnabled: true,
      approvalPolicy: 'never',
      model: 'gpt-test-model',
      mcpToolNames: ['report_task_result'],
      sdkSandboxMode: 'danger-full-access',
      hasSystemMcp: true,
      systemMcpRequired: true
    })
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})
