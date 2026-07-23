import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { CLAUDE_DESCRIPTOR } from '../../src/shared/providers/descriptors/claude.ts'
import { DEFAULT_PROVIDERS_CONFIG } from '../../src/shared/providers/settings.ts'
import type { ProviderInstallation } from '../../src/shared/providers/installation.ts'
import type { AgentTurnChunk, AgentTurnInput } from '../../src/server/agent-runtime/types.ts'
import { buildProviderTurnContext } from '../../src/server/providers/driver.ts'
import { resolveProviderExecutable } from '../../src/server/providers/executable.ts'
import { createProviderRegistry } from '../../src/server/providers/composition.ts'
import {
  ClaudeDriver,
  createClaudeStreamFactory
} from '../../src/server/providers/claude/driver.ts'
import { buildClaudeTurnOptions } from '../../src/server/providers/claude/turn-options.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

const installation: ProviderInstallation = Object.freeze({
  id: 'claude-code:test-delegation',
  provider: 'claude-code',
  command: 'claude',
  source: 'path',
  invocation: Object.freeze({ executable: '/bin/claude', prefixArgs: Object.freeze([]) }),
  resolvedPath: '/bin/claude',
  canonicalPath: '/bin/claude'
})

function baseInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    provider: 'claude-code',
    role: 'conversation',
    cwd: '/workspace',
    runtimeRoot: '/runtime/claude',
    prompt: 'delegate-me',
    ...overrides
  }
}

test('ClaudeDriver shell uses shared Claude descriptor and production kind', () => {
  const driver = new ClaudeDriver(DEFAULT_PROVIDERS_CONFIG['claude-code'])
  assert.equal(driver.kind, 'production')
  assert.equal(driver.descriptor, CLAUDE_DESCRIPTOR)
  assert.equal(driver.descriptor.code, 'claude-code')
  assert.equal(driver.settings, DEFAULT_PROVIDERS_CONFIG['claude-code'])
})

test('ClaudeDriver prepareTurn delegates to stream factory without altering chunks', async () => {
  const seen: Array<{ prompt: string; outerSandbox: boolean | undefined }> = []
  async function* factory(
    input: AgentTurnInput,
    options?: { outerSandbox?: boolean }
  ): AsyncGenerator<AgentTurnChunk> {
    seen.push({ prompt: input.prompt, outerSandbox: options?.outerSandbox })
    yield { type: 'delta', content: 'hi' }
    yield { type: 'completed', reply: 'hi', runtimeSessionId: 'sess-1' }
  }

  const driver = new ClaudeDriver(DEFAULT_PROVIDERS_CONFIG['claude-code'], factory)
  const prepared = await driver.prepareTurn(
    buildProviderTurnContext({
      input: baseInput(),
      options: { outerSandbox: false },
      installation,
      authMode: 'runtime-copy'
    })
  )

  const chunks: AgentTurnChunk[] = []
  for await (const chunk of prepared.stream()) {
    chunks.push(chunk)
  }

  assert.deepEqual(seen, [{ prompt: 'delegate-me', outerSandbox: false }])
  assert.deepEqual(chunks, [
    { type: 'delta', content: 'hi' },
    { type: 'completed', reply: 'hi', runtimeSessionId: 'sess-1' }
  ])
  assert.equal(prepared.installation.id, installation.id)
  assert.equal(prepared.reusePolicy, 'conversation-scoped')
})

test('default Claude stream factory delegates to legacy streamClaudeTurn', () => {
  const source = readFileSync(join(root, 'src/server/providers/claude/driver.ts'), 'utf8')
  assert.match(source, /createClaudeStreamFactory/)
  assert.match(source, /streamClaudeTurn/)
  assert.match(source, /agent-runtime\/providers\/claude-sdk/)
  assert.equal(typeof createClaudeStreamFactory, 'function')
})

test('Registry Claude entry uses the shared descriptor without a parallel runtime catalog', () => {
  const descriptorSource = readFileSync(
    join(root, 'src/server/providers/claude/descriptor.ts'),
    'utf8'
  )
  assert.equal(existsSync(join(root, 'src/server/providers/catalog.ts')), false)
  assert.equal(createProviderRegistry().get('claude-code').descriptor, CLAUDE_DESCRIPTOR)
  assert.doesNotMatch(descriptorSource, /label:|description:|defaultCommands:/)
})

test('ClaudeDriver.discover returns a stable installationId matching the resolver', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cctask-claude-discover-'))
  const bin = join(dir, 'claude-discovered')
  writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  chmodSync(bin, 0o755)

  try {
    const settings = {
      enabled: true,
      executable: { mode: 'path' as const, path: bin },
      approveMcps: false
    }
    const driver = new ClaudeDriver(settings)
    const hostEnvironment = Object.freeze({ PATH: '/usr/bin' })
    const first = await driver.discover({ hostEnvironment, installDirs: [] })
    const second = await driver.discover({ hostEnvironment, installDirs: [] })
    const viaResolver = resolveProviderExecutable('claude-code', {
      settings,
      env: hostEnvironment,
      installDirs: []
    })

    assert.ok(first)
    assert.ok(second)
    assert.ok(viaResolver)
    assert.equal(first.id, second.id)
    assert.equal(first.id, viaResolver.installationId)
    assert.equal(first.resolvedPath, bin)
    assert.equal(first.canonicalPath, realpathSync(bin))
    assert.equal(first.source, 'app-config')
    assert.equal(first.provider, 'claude-code')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('central preflight switch no longer handles Claude; driver owns preflight', () => {
  const driverSource = readFileSync(join(root, 'src/server/providers/claude/driver.ts'), 'utf8')
  const claudePreflight = readFileSync(
    join(root, 'src/server/providers/claude/preflight.ts'),
    'utf8'
  )

  assert.equal(existsSync(join(root, 'src/server/sandbox/provider-auth/preflight.ts')), false)
  assert.equal(existsSync(join(root, 'src/server/providers/provider-subsystem.ts')), false)
  assert.match(driverSource, /runClaudeAuthPreflight/)
  assert.match(driverSource, /preflight:\s*\(context\)/)
  assert.match(claudePreflight, /export function runClaudeAuthPreflight/)
  assert.doesNotMatch(claudePreflight, /resolveProviderExecutable/)
})

test('buildClaudeTurnOptions lives in Claude driver module; runner does not import Claude policy', () => {
  const turnOptions = readFileSync(
    join(root, 'src/server/providers/claude/turn-options.ts'),
    'utf8'
  )
  const sdk = readFileSync(join(root, 'src/server/agent-runtime/providers/claude-sdk.ts'), 'utf8')
  const runner = readFileSync(join(root, 'src/server/agent-runtime/runner.ts'), 'utf8')

  assert.match(turnOptions, /export function buildClaudeTurnOptions/)
  assert.match(sdk, /from '\.\.\/\.\.\/providers\/claude\/turn-options'/)
  assert.doesNotMatch(sdk, /from '\.\/claude-policy'/)
  assert.doesNotMatch(runner, /claude-policy|buildClaudeTurnOptions/)
  assert.equal(existsSync(join(root, 'src/server/agent-runtime/providers/claude-policy.ts')), false)
})

test('detect installation path is passed as pathToClaudeCodeExecutable with same installationId', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cctask-claude-path-override-'))
  const bin = join(dir, 'claude-sdk-path')
  writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  chmodSync(bin, 0o755)

  try {
    const settings = {
      enabled: true,
      executable: { mode: 'path' as const, path: bin },
      approveMcps: false
    }
    const driver = new ClaudeDriver(settings)
    const discovered = await driver.discover({
      hostEnvironment: Object.freeze({ PATH: '/usr/bin' }),
      installDirs: []
    })
    assert.ok(discovered)

    const plan = buildClaudeTurnOptions({
      provider: 'claude-code',
      role: 'conversation',
      cwd: '/workspace',
      runtimeRoot: dir,
      prompt: 'hi',
      installation: discovered
    })

    assert.equal(plan.installationId, discovered.id)
    assert.equal(plan.pathToClaudeCodeExecutable, discovered.invocation.executable)
    assert.equal(plan.pathToClaudeCodeExecutable, bin)

    const sdk = readFileSync(join(root, 'src/server/agent-runtime/providers/claude-sdk.ts'), 'utf8')
    assert.match(sdk, /pathToClaudeCodeExecutable:\s*plan\.pathToClaudeCodeExecutable/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ClaudeDriver turn handle uses RuntimeManager cancel/close contract', async () => {
  const { ProviderRuntimeManager } = await import('../../src/server/providers/lifecycle.ts')
  const events: string[] = []

  async function* factory(
    _input: AgentTurnInput,
    options?: { signal?: AbortSignal }
  ): AsyncGenerator<AgentTurnChunk> {
    events.push('start')
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => {
        events.push('aborted')
        reject(options?.signal?.reason ?? new Error('aborted'))
      }
      if (options?.signal?.aborted) {
        onAbort()
        return
      }
      options?.signal?.addEventListener('abort', onAbort, { once: true })
    })
    yield { type: 'delta', content: 'partial' }
    await aborted
    events.push('should-not-reach')
    yield { type: 'completed', reply: 'done', runtimeSessionId: null }
  }

  const driver = new ClaudeDriver(DEFAULT_PROVIDERS_CONFIG['claude-code'], factory)
  const prepared = await driver.prepareTurn(
    buildProviderTurnContext({
      input: baseInput({ role: 'task-worker', prompt: 'managed' }),
      options: { outerSandbox: true },
      installation,
      authMode: 'runtime-copy'
    })
  )

  assert.equal(prepared.reusePolicy, 'one-shot')
  const handleIter = prepared.stream()
  const first = await handleIter.next()
  assert.deepEqual(first.value, { type: 'delta', content: 'partial' })

  const cancelReason = new Error('claude-cancel')
  const pending = handleIter.next().then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason })
  )
  await prepared.cancel(cancelReason)
  const outcome = await pending
  assert.equal(outcome.status, 'rejected')
  assert.match(String(outcome.reason), /claude-cancel/)
  assert.ok(events.includes('aborted'))
  await prepared.close()

  const manager = new ProviderRuntimeManager()
  async function* completingFactory(): AsyncGenerator<AgentTurnChunk> {
    yield { type: 'delta', content: 'a' }
    yield { type: 'completed', reply: 'a', runtimeSessionId: 's1' }
  }
  const completingDriver = new ClaudeDriver(
    DEFAULT_PROVIDERS_CONFIG['claude-code'],
    completingFactory
  )
  const chunks: AgentTurnChunk[] = []
  for await (const chunk of manager.stream(
    completingDriver,
    buildProviderTurnContext({
      input: baseInput({ prompt: 'ok' }),
      options: { outerSandbox: false },
      installation,
      authMode: 'runtime-copy'
    })
  )) {
    chunks.push(chunk)
  }
  assert.deepEqual(chunks, [
    { type: 'delta', content: 'a' },
    { type: 'completed', reply: 'a', runtimeSessionId: 's1' }
  ])
  assert.equal(manager.activeCount(), 0)
})

test('production Claude streamClaudeTurn routes through getAgentTurnProvider / RuntimeManager', () => {
  const indexSource = readFileSync(
    join(root, 'src/server/agent-runtime/providers/index.ts'),
    'utf8'
  )
  assert.match(indexSource, /getAgentTurnProvider\('claude-code'\)\.streamTurn/)
  assert.doesNotMatch(indexSource, /streamClaudeTurn[\s\S]*await import\('\.\/claude-sdk'\)/)
})

test('role-worker-claude-code production entry uses Registry ClaudeDriver', () => {
  const worker = readFileSync(join(root, 'src/sandbox/role-worker-claude-code.ts'), 'utf8')
  assert.match(worker, /getAgentTurnProvider\('claude-code'\)/)
  assert.doesNotMatch(worker, /providers\/claude-sdk/)
})

test('sandbox orchestrator uses ClaudeDriver.preflight for Claude', () => {
  const orchestrator = readFileSync(join(root, 'src/server/sandbox/orchestrator-local.ts'), 'utf8')
  assert.match(orchestrator, /getProviderRegistry\(\)\.get\(input\.coreCode\)/)
  assert.match(orchestrator, /driver\.preflight/)
  assert.match(orchestrator, /contributeSandboxPolicy/)
})

test('Claude registry production driver matches descriptor and settings slot', () => {
  const registry = createProviderRegistry(DEFAULT_PROVIDERS_CONFIG)
  const driver = registry.get('claude-code')
  assert.equal(driver.kind, 'production')
  assert.equal(driver.descriptor, CLAUDE_DESCRIPTOR)
  assert.equal(driver.settings, DEFAULT_PROVIDERS_CONFIG['claude-code'])
  assert.equal(driver.descriptor.capabilities.protocol, 'sdk')
  assert.equal(driver.descriptor.capabilities.authMode, 'runtime-copy')
})

test('Claude turn options parity snapshots stay stable for settings/MCP/permissions', () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'cctask-claude-parity-'))
  try {
    const conversation = buildClaudeTurnOptions(
      {
        ...baseInput({
          runtimeRoot,
          model: 'claude-test',
          mcpUrl: 'http://127.0.0.1:9/mcp',
          capabilityProfile: 'chat-write'
        })
      },
      { outerSandbox: false }
    )
    const planner = buildClaudeTurnOptions(
      {
        ...baseInput({
          role: 'planner',
          runtimeRoot,
          model: 'claude-test',
          mcpUrl: 'http://127.0.0.1:9/mcp',
          capabilityProfile: 'planner-read'
        })
      },
      { outerSandbox: false }
    )
    const task = buildClaudeTurnOptions(
      {
        ...baseInput({
          role: 'task-worker',
          runtimeRoot,
          model: 'claude-test',
          mcpUrl: 'http://127.0.0.1:9/mcp'
        })
      },
      { outerSandbox: true }
    )

    assert.deepEqual([...conversation.settingSources], ['user', 'project', 'local'])
    assert.equal(conversation.readOnly, false)
    assert.equal(conversation.pinMcpConfig, true)
    assert.equal(conversation.model, 'claude-test')
    assert.ok(conversation.allowedTools.some((tool) => tool.startsWith('mcp__')))

    assert.deepEqual([...planner.settingSources], ['user', 'project', 'local'])
    assert.equal(planner.readOnly, true)
    assert.ok(planner.disallowedTools.includes('Bash'))
    assert.ok(planner.disallowedTools.includes('Edit'))

    assert.deepEqual([...task.settingSources], [])
    assert.equal(task.outerSandbox, true)
    assert.equal(task.readOnly, false)
    assert.equal(task.pinMcpConfig, true)
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})
