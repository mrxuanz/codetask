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
import { OPENCODE_DESCRIPTOR } from '../../src/shared/providers/descriptors/opencode.ts'
import { DEFAULT_PROVIDERS_CONFIG } from '../../src/shared/providers/settings.ts'
import type { ProviderInstallation } from '../../src/shared/providers/installation.ts'
import type { AgentTurnChunk, AgentTurnInput } from '../../src/server/agent-runtime/types.ts'
import { buildProviderTurnContext } from '../../src/server/providers/driver.ts'
import { resolveProviderExecutable } from '../../src/server/providers/executable.ts'
import { createProviderRegistry } from '../../src/server/providers/composition.ts'
import {
  OpenCodeDriver,
  createOpenCodeStreamFactory
} from '../../src/server/providers/opencode/driver.ts'
import { buildOpenCodeServerPlan } from '../../src/server/providers/opencode/server-plan.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

const installation: ProviderInstallation = Object.freeze({
  id: 'opencode:test-delegation',
  provider: 'opencode',
  command: 'opencode',
  source: 'path',
  invocation: Object.freeze({ executable: '/bin/opencode', prefixArgs: Object.freeze([]) }),
  resolvedPath: '/bin/opencode',
  canonicalPath: '/bin/opencode'
})

function baseInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    provider: 'opencode',
    role: 'conversation',
    cwd: '/workspace',
    runtimeRoot: '/runtime/opencode',
    prompt: 'delegate-me',
    ...overrides
  }
}

test('OpenCodeDriver shell uses shared OpenCode descriptor and production kind', () => {
  const driver = new OpenCodeDriver(DEFAULT_PROVIDERS_CONFIG.opencode)
  assert.equal(driver.kind, 'production')
  assert.equal(driver.descriptor, OPENCODE_DESCRIPTOR)
  assert.equal(driver.descriptor.code, 'opencode')
  assert.equal(driver.settings, DEFAULT_PROVIDERS_CONFIG.opencode)
})

test('OpenCodeDriver prepareTurn delegates to stream factory without altering chunks', async () => {
  const seen: Array<{ prompt: string; outerSandbox: boolean | undefined }> = []
  async function* factory(
    input: AgentTurnInput,
    options?: { outerSandbox?: boolean }
  ): AsyncGenerator<AgentTurnChunk> {
    seen.push({ prompt: input.prompt, outerSandbox: options?.outerSandbox })
    yield { type: 'delta', content: 'hi' }
    yield { type: 'completed', reply: 'hi', runtimeSessionId: 'sess-1' }
  }

  const driver = new OpenCodeDriver(DEFAULT_PROVIDERS_CONFIG.opencode, factory)
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

test('default OpenCode stream factory delegates to legacy streamOpencodeTurn', () => {
  const source = readFileSync(join(root, 'src/server/providers/opencode/driver.ts'), 'utf8')
  assert.match(source, /createOpenCodeStreamFactory/)
  assert.match(source, /streamOpencodeTurn/)
  assert.match(source, /agent-runtime\/providers\/opencode-sdk/)
  assert.equal(typeof createOpenCodeStreamFactory, 'function')
})

test('Registry OpenCode entry uses the shared descriptor without a parallel runtime catalog', () => {
  const descriptorSource = readFileSync(
    join(root, 'src/server/providers/opencode/descriptor.ts'),
    'utf8'
  )
  assert.equal(existsSync(join(root, 'src/server/providers/catalog.ts')), false)
  assert.equal(createProviderRegistry().get('opencode').descriptor, OPENCODE_DESCRIPTOR)
  assert.doesNotMatch(descriptorSource, /label:|description:|defaultCommands:/)
})

test('OpenCodeDriver.discover returns a stable installationId matching the resolver', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cctask-opencode-discover-'))
  const bin = join(dir, 'opencode-discovered')
  writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  chmodSync(bin, 0o755)

  try {
    const settings = {
      enabled: true,
      executable: { mode: 'path' as const, path: bin },
      approveMcps: false
    }
    const driver = new OpenCodeDriver(settings)
    const hostEnvironment = Object.freeze({ PATH: '/usr/bin' })
    const first = await driver.discover({ hostEnvironment, installDirs: [] })
    const second = await driver.discover({ hostEnvironment, installDirs: [] })
    const viaResolver = resolveProviderExecutable('opencode', {
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
    assert.equal(first.provider, 'opencode')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('central preflight switch no longer handles OpenCode; driver owns preflight', () => {
  const driverSource = readFileSync(join(root, 'src/server/providers/opencode/driver.ts'), 'utf8')
  const openCodePreflight = readFileSync(
    join(root, 'src/server/providers/opencode/preflight.ts'),
    'utf8'
  )

  assert.equal(existsSync(join(root, 'src/server/sandbox/provider-auth/preflight.ts')), false)
  assert.equal(existsSync(join(root, 'src/server/providers/provider-subsystem.ts')), false)
  assert.match(driverSource, /runOpenCodeAuthPreflight/)
  assert.match(driverSource, /preflight:\s*\(context\)/)
  assert.match(openCodePreflight, /export function runOpenCodeAuthPreflight/)
  assert.doesNotMatch(openCodePreflight, /resolveProviderExecutable/)
})

test('buildOpenCodeServerPlan lives in OpenCode driver module; structured serve args', () => {
  const serverPlan = readFileSync(
    join(root, 'src/server/providers/opencode/server-plan.ts'),
    'utf8'
  )
  const sdk = readFileSync(join(root, 'src/server/agent-runtime/providers/opencode-sdk.ts'), 'utf8')

  assert.match(serverPlan, /export function buildOpenCodeServerPlan/)
  assert.match(serverPlan, /hostname/)
  assert.match(serverPlan, /pure/)
  assert.match(serverPlan, /logLevel/)
  assert.match(sdk, /from '\.\.\/\.\.\/providers\/opencode\/server-plan'/)
  assert.match(sdk, /buildOpenCodeServerPlan/)
  assert.match(sdk, /plan\.buildServeArgs/)
  assert.doesNotMatch(sdk, /function buildOpencodeConfig/)
})

test('detect installation path is used for OpenCode server spawn with same installationId', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cctask-opencode-path-'))
  const bin = join(dir, 'opencode-sdk-path')
  writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  chmodSync(bin, 0o755)

  try {
    const settings = {
      enabled: true,
      executable: { mode: 'path' as const, path: bin },
      approveMcps: false
    }
    const driver = new OpenCodeDriver(settings)
    const discovered = await driver.discover({
      hostEnvironment: Object.freeze({ PATH: '/usr/bin' }),
      installDirs: []
    })
    assert.ok(discovered)

    const plan = buildOpenCodeServerPlan({
      provider: 'opencode',
      role: 'conversation',
      cwd: '/workspace',
      runtimeRoot: dir,
      prompt: 'hi',
      installation: discovered,
      capabilityProfile: 'chat-read'
    })

    assert.equal(plan.installationId, discovered.id)
    assert.equal(plan.executable, discovered.invocation.executable)
    assert.equal(plan.executable, bin)
    assert.equal(plan.pure, true)
    assert.deepEqual(
      [...plan.buildServeArgs(4123)],
      ['serve', '--hostname=127.0.0.1', '--port=4123', '--pure']
    )

    const sdk = readFileSync(
      join(root, 'src/server/agent-runtime/providers/opencode-sdk.ts'),
      'utf8'
    )
    assert.match(sdk, /executable:\s*plan\.executable/)
    assert.match(sdk, /prefixArgs:\s*plan\.prefixArgs/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('OpenCodeDriver turn handle uses RuntimeManager cancel/close contract', async () => {
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

  const driver = new OpenCodeDriver(DEFAULT_PROVIDERS_CONFIG.opencode, factory)
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

  const cancelReason = new Error('opencode-cancel')
  const pending = handleIter.next().then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason })
  )
  await prepared.cancel(cancelReason)
  const outcome = await pending
  assert.equal(outcome.status, 'rejected')
  assert.match(String(outcome.reason), /opencode-cancel/)
  assert.ok(events.includes('aborted'))
  await prepared.close()

  const manager = new ProviderRuntimeManager()
  async function* completingFactory(): AsyncGenerator<AgentTurnChunk> {
    yield { type: 'delta', content: 'a' }
    yield { type: 'completed', reply: 'a', runtimeSessionId: 's1' }
  }
  const completingDriver = new OpenCodeDriver(DEFAULT_PROVIDERS_CONFIG.opencode, completingFactory)
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

test('production OpenCode streamOpencodeTurn routes through getAgentTurnProvider / RuntimeManager', () => {
  const indexSource = readFileSync(
    join(root, 'src/server/agent-runtime/providers/index.ts'),
    'utf8'
  )
  assert.match(indexSource, /getAgentTurnProvider\('opencode'\)\.streamTurn/)
  assert.doesNotMatch(indexSource, /streamOpencodeTurn[\s\S]*await import\('\.\/opencode-sdk'\)/)
})

test('role-worker-opencode production entry uses Registry OpenCodeDriver', () => {
  const worker = readFileSync(join(root, 'src/sandbox/role-worker-opencode.ts'), 'utf8')
  assert.match(worker, /getAgentTurnProvider\('opencode'\)/)
  assert.doesNotMatch(worker, /providers\/opencode-sdk/)
})

test('sandbox orchestrator uses OpenCodeDriver.preflight for OpenCode', () => {
  const orchestrator = readFileSync(join(root, 'src/server/sandbox/orchestrator-local.ts'), 'utf8')
  assert.match(orchestrator, /getProviderRegistry\(\)\.get\(input\.coreCode\)/)
  assert.match(orchestrator, /driver\.preflight/)
  assert.match(orchestrator, /contributeSandboxPolicy/)
})

test('OpenCode registry production driver matches descriptor and settings slot', () => {
  const registry = createProviderRegistry(DEFAULT_PROVIDERS_CONFIG)
  const driver = registry.get('opencode')
  assert.equal(driver.kind, 'production')
  assert.equal(driver.descriptor, OPENCODE_DESCRIPTOR)
  assert.equal(driver.settings, DEFAULT_PROVIDERS_CONFIG.opencode)
  assert.equal(driver.descriptor.capabilities.protocol, 'local-server')
  assert.equal(driver.descriptor.capabilities.authMode, 'runtime-copy')
})

test('OpenCode server plan parity snapshots stay stable for question deny / MCP / pure', () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'cctask-opencode-parity-'))
  try {
    const conversation = buildOpenCodeServerPlan(
      {
        ...baseInput({
          runtimeRoot,
          model: 'opencode-test',
          mcpUrl: 'http://127.0.0.1:9/mcp',
          capabilityProfile: 'chat-write'
        })
      },
      { outerSandbox: false }
    )
    const planner = buildOpenCodeServerPlan(
      {
        ...baseInput({
          role: 'planner',
          runtimeRoot,
          model: 'opencode-test',
          mcpUrl: 'http://127.0.0.1:9/mcp',
          capabilityProfile: 'planner-read'
        })
      },
      { outerSandbox: false }
    )
    const task = buildOpenCodeServerPlan(
      {
        ...baseInput({
          role: 'task-worker',
          runtimeRoot,
          model: 'opencode-test',
          mcpUrl: 'http://127.0.0.1:9/mcp'
        })
      },
      { outerSandbox: true }
    )

    assert.equal(conversation.pure, false)
    assert.equal(conversation.config.permission?.question, 'deny')
    assert.equal(conversation.config.tools?.question, false)
    assert.equal(conversation.config.model, 'opencode-test')
    assert.ok(conversation.config.mcp)

    assert.equal(planner.pure, true)
    assert.deepEqual(
      [...planner.buildServeArgs(9)],
      ['serve', '--hostname=127.0.0.1', '--port=9', '--pure']
    )
    assert.equal(planner.config.permission?.question, 'deny')
    assert.deepEqual(planner.config.plugin, [])

    assert.equal(task.outerSandbox, true)
    assert.equal(task.pure, false)
    assert.equal(task.config.permission?.question, 'deny')
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})
