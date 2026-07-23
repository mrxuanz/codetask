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
import { CURSOR_DESCRIPTOR } from '../../src/shared/providers/descriptors/cursor.ts'
import { DEFAULT_PROVIDERS_CONFIG } from '../../src/shared/providers/settings.ts'
import type { ProviderInstallation } from '../../src/shared/providers/installation.ts'
import type { AgentTurnChunk, AgentTurnInput } from '../../src/server/agent-runtime/types.ts'
import { buildProviderTurnContext } from '../../src/server/providers/driver.ts'
import { resolveProviderExecutable } from '../../src/server/providers/executable.ts'
import { createProviderRegistry } from '../../src/server/providers/composition.ts'
import {
  CursorDriver,
  createCursorStreamFactory
} from '../../src/server/providers/cursor/driver.ts'
import {
  buildCursorAcpCliArgs,
  buildCursorTurnPlan
} from '../../src/server/providers/cursor/turn-plan.ts'
import { providerInstallationResolver } from '../../src/server/providers/installation.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

const installation: ProviderInstallation = Object.freeze({
  id: 'cursorcli:test-delegation',
  provider: 'cursorcli',
  command: 'agent',
  source: 'path',
  invocation: Object.freeze({ executable: '/bin/agent', prefixArgs: Object.freeze([]) }),
  resolvedPath: '/bin/agent',
  canonicalPath: '/bin/agent'
})

function baseInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    provider: 'cursorcli',
    role: 'conversation',
    cwd: '/workspace',
    runtimeRoot: '/runtime/cursor',
    prompt: 'delegate-me',
    ...overrides
  }
}

test('CursorDriver shell uses shared Cursor descriptor and production kind', () => {
  const driver = new CursorDriver(DEFAULT_PROVIDERS_CONFIG.cursorcli)
  assert.equal(driver.kind, 'production')
  assert.equal(driver.descriptor, CURSOR_DESCRIPTOR)
  assert.equal(driver.descriptor.code, 'cursorcli')
  assert.equal(driver.settings, DEFAULT_PROVIDERS_CONFIG.cursorcli)
})

test('CursorDriver prepareTurn delegates to stream factory without altering chunks', async () => {
  const seen: Array<{ prompt: string; outerSandbox: boolean | undefined }> = []
  async function* factory(
    input: AgentTurnInput,
    options?: { outerSandbox?: boolean }
  ): AsyncGenerator<AgentTurnChunk> {
    seen.push({ prompt: input.prompt, outerSandbox: options?.outerSandbox })
    yield { type: 'delta', content: 'hi' }
    yield { type: 'completed', reply: 'hi', runtimeSessionId: 'sess-1' }
  }

  const driver = new CursorDriver(DEFAULT_PROVIDERS_CONFIG.cursorcli, factory)
  const prepared = await driver.prepareTurn(
    buildProviderTurnContext({
      input: baseInput(),
      options: { outerSandbox: false },
      installation,
      authMode: 'host-identity'
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

test('default Cursor stream factory delegates to legacy streamCursorAcpTurn', () => {
  const source = readFileSync(join(root, 'src/server/providers/cursor/driver.ts'), 'utf8')
  assert.match(source, /createCursorStreamFactory/)
  assert.match(source, /streamCursorAcpTurn/)
  assert.match(source, /agent-runtime\/providers\/cursor-acp/)
  assert.equal(typeof createCursorStreamFactory, 'function')
})

test('Registry Cursor entry uses the shared descriptor without a parallel runtime catalog', () => {
  const descriptorSource = readFileSync(
    join(root, 'src/server/providers/cursor/descriptor.ts'),
    'utf8'
  )
  assert.equal(existsSync(join(root, 'src/server/providers/catalog.ts')), false)
  assert.equal(createProviderRegistry().get('cursorcli').descriptor, CURSOR_DESCRIPTOR)
  assert.doesNotMatch(descriptorSource, /label:|description:|defaultCommands:/)
})

test('CursorDriver.discover returns a stable installationId matching the resolver', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cctask-cursor-discover-'))
  const bin = join(dir, 'agent-discovered')
  writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  chmodSync(bin, 0o755)

  try {
    const settings = {
      enabled: true,
      executable: { mode: 'path' as const, path: bin },
      approveMcps: true
    }
    const driver = new CursorDriver(settings)
    const hostEnvironment = Object.freeze({ PATH: '/usr/bin' })
    const first = await driver.discover({ hostEnvironment, installDirs: [] })
    const second = await driver.discover({ hostEnvironment, installDirs: [] })
    const viaResolver = resolveProviderExecutable('cursorcli', {
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
    assert.equal(first.provider, 'cursorcli')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CursorDriver.discover keeps Windows .cmd shim prefixArgs empty and stable id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cctask-cursor-cmd-'))
  const cmd = join(dir, 'agent.cmd')
  writeFileSync(cmd, '@echo off\r\n', { mode: 0o755 })

  try {
    const settings = {
      enabled: true,
      executable: { mode: 'path' as const, path: cmd },
      approveMcps: true
    }
    const installation = providerInstallationResolver.resolve('cursorcli', {
      settings,
      hostEnv: Object.freeze({ PATH: dir }),
      platform: 'win32',
      installDirs: []
    })
    assert.ok(installation)
    assert.equal(installation.invocation.executable, cmd)
    assert.equal(installation.canonicalPath, realpathSync(cmd))
    assert.deepEqual([...installation.invocation.prefixArgs], [])

    const driver = new CursorDriver(settings)
    const discovered = await driver.discover({
      hostEnvironment: Object.freeze({ PATH: dir }),
      platform: 'win32',
      installDirs: []
    })
    assert.ok(discovered)
    assert.equal(discovered.id, installation.id)
    assert.deepEqual([...discovered.invocation.prefixArgs], [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('central preflight switch no longer handles Cursor; driver owns preflight', () => {
  const driverSource = readFileSync(join(root, 'src/server/providers/cursor/driver.ts'), 'utf8')
  const cursorPreflight = readFileSync(
    join(root, 'src/server/providers/cursor/preflight.ts'),
    'utf8'
  )

  assert.equal(existsSync(join(root, 'src/server/sandbox/provider-auth/preflight.ts')), false)
  assert.equal(existsSync(join(root, 'src/server/providers/provider-subsystem.ts')), false)
  assert.match(driverSource, /runCursorAuthPreflight/)
  assert.match(driverSource, /preflight:\s*\(context\)/)
  assert.match(cursorPreflight, /export function runCursorAuthPreflight/)
  assert.doesNotMatch(cursorPreflight, /resolveProviderExecutable/)
})

test('buildCursorTurnPlan lives in Cursor driver module; outer layers do not read Cursor env', () => {
  const turnPlan = readFileSync(join(root, 'src/server/providers/cursor/turn-plan.ts'), 'utf8')
  const stream = readFileSync(
    join(root, 'src/server/agent-runtime/cursor-acp/stream-session-turn.ts'),
    'utf8'
  )
  const runner = readFileSync(join(root, 'src/server/agent-runtime/runner.ts'), 'utf8')
  const providerPolicy = readFileSync(
    join(root, 'src/server/agent-runtime/provider-policy.ts'),
    'utf8'
  )

  assert.match(turnPlan, /export function buildCursorTurnPlan/)
  assert.doesNotMatch(turnPlan, /CODETASK_CURSOR_API_ENDPOINT/)
  assert.doesNotMatch(turnPlan, /CODETASK_CURSOR_APPROVE_MCPS/)
  assert.match(stream, /from '\.\.\/\.\.\/providers\/cursor\/turn-plan'/)
  assert.doesNotMatch(runner, /CODETASK_CURSOR_API_ENDPOINT|CODETASK_CURSOR_APPROVE_MCPS/)
  assert.equal(existsSync(join(root, 'src/server/agent-runtime/providers/cursor-policy.ts')), false)
  assert.doesNotMatch(providerPolicy, /buildCursorAcpCliArgs/)
  assert.doesNotMatch(providerPolicy, /CODETASK_CURSOR/)
})

test('detect installation path is passed into ACP spawn plan with same installationId', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cctask-cursor-path-'))
  const bin = join(dir, 'agent-sdk-path')
  writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  chmodSync(bin, 0o755)

  try {
    const settings = {
      enabled: true,
      executable: { mode: 'path' as const, path: bin },
      approveMcps: true,
      endpoint: 'https://cursor.example/api'
    }
    const driver = new CursorDriver(settings)
    const discovered = await driver.discover({
      hostEnvironment: Object.freeze({ PATH: '/usr/bin' }),
      installDirs: []
    })
    assert.ok(discovered)

    const plan = buildCursorTurnPlan(
      {
        provider: 'cursorcli',
        role: 'conversation',
        cwd: '/workspace',
        runtimeRoot: dir,
        prompt: 'hi',
        installation: discovered,
        capabilityProfile: 'chat-write'
      },
      { endpoint: settings.endpoint, approveMcps: settings.approveMcps }
    )

    assert.equal(plan.installationId, discovered.id)
    assert.equal(plan.executable, discovered.invocation.executable)
    assert.equal(plan.executable, bin)
    assert.deepEqual(plan.cliArgs.slice(0, 2), ['-e', 'https://cursor.example/api'])
    assert.ok(plan.cliArgs.includes('acp'))

    const stream = readFileSync(
      join(root, 'src/server/agent-runtime/cursor-acp/stream-session-turn.ts'),
      'utf8'
    )
    assert.match(stream, /executable:\s*plan\.executable/)
    assert.match(stream, /prefixArgs:\s*plan\.prefixArgs/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CursorDriver turn handle uses RuntimeManager cancel/close and manager-selected scope', async () => {
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

  const driver = new CursorDriver(DEFAULT_PROVIDERS_CONFIG.cursorcli, factory)
  const prepared = await driver.prepareTurn(
    buildProviderTurnContext({
      input: baseInput({ role: 'task-worker', prompt: 'managed', jobId: 'job-1' }),
      options: { outerSandbox: true },
      installation,
      authMode: 'host-identity'
    })
  )

  assert.equal(prepared.reusePolicy, 'one-shot')
  const handleIter = prepared.stream()
  const first = await handleIter.next()
  assert.deepEqual(first.value, { type: 'delta', content: 'partial' })

  const cancelReason = new Error('cursor-cancel')
  const pending = handleIter.next().then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason })
  )
  await prepared.cancel(cancelReason)
  const outcome = await pending
  assert.equal(outcome.status, 'rejected')
  assert.match(String(outcome.reason), /cursor-cancel/)
  assert.ok(events.includes('aborted'))

  const manager = new ProviderRuntimeManager()
  const scopes: AgentTurnInput['providerRuntimeScope'][] = []
  async function* completingFactory(input: AgentTurnInput): AsyncGenerator<AgentTurnChunk> {
    scopes.push(input.providerRuntimeScope)
    yield { type: 'delta', content: 'a' }
    yield { type: 'completed', reply: 'a', runtimeSessionId: 's1' }
  }
  const completingDriver = new CursorDriver(DEFAULT_PROVIDERS_CONFIG.cursorcli, completingFactory)
  const chunks: AgentTurnChunk[] = []
  for await (const chunk of manager.stream(
    completingDriver,
    buildProviderTurnContext({
      input: baseInput({ prompt: 'ok' }),
      options: { outerSandbox: false },
      installation,
      authMode: 'host-identity'
    })
  )) {
    chunks.push(chunk)
  }
  assert.deepEqual(chunks, [
    { type: 'delta', content: 'a' },
    { type: 'completed', reply: 'a', runtimeSessionId: 's1' }
  ])
  assert.equal(manager.activeCount(), 0)
  assert.equal(scopes[0]?.reusePolicy, 'conversation-scoped')
  assert.equal(scopes[0]?.id, 'conversation:/runtime/cursor')
  assert.equal(completingDriver.descriptor.capabilities.reuse.includes('conversation-scoped'), true)
})

test('production Cursor streamCursorAcpTurn routes through getAgentTurnProvider / RuntimeManager', () => {
  const indexSource = readFileSync(
    join(root, 'src/server/agent-runtime/providers/index.ts'),
    'utf8'
  )
  assert.match(indexSource, /getAgentTurnProvider\('cursorcli'\)\.streamTurn/)
  assert.doesNotMatch(indexSource, /streamCursorAcpTurn[\s\S]*await import\('\.\/cursor-acp'\)/)
})

test('role-worker-cursorcli production entry uses Registry CursorDriver', () => {
  const worker = readFileSync(join(root, 'src/sandbox/role-worker-cursorcli.ts'), 'utf8')
  assert.match(worker, /getAgentTurnProvider\('cursorcli'\)/)
  assert.doesNotMatch(worker, /providers\/cursor-acp/)
})

test('sandbox orchestrator uses CursorDriver.preflight for Cursor', () => {
  const orchestrator = readFileSync(join(root, 'src/server/sandbox/orchestrator-local.ts'), 'utf8')
  assert.match(orchestrator, /getProviderRegistry\(\)\.get\(input\.coreCode\)/)
  assert.match(orchestrator, /driver\.preflight/)
  assert.match(orchestrator, /contributeSandboxPolicy/)
})

test('Cursor registry production driver matches descriptor and settings slot', () => {
  const registry = createProviderRegistry(DEFAULT_PROVIDERS_CONFIG)
  const driver = registry.get('cursorcli')
  assert.equal(driver.kind, 'production')
  assert.equal(driver.descriptor, CURSOR_DESCRIPTOR)
  assert.equal(driver.settings, DEFAULT_PROVIDERS_CONFIG.cursorcli)
  assert.equal(driver.descriptor.capabilities.protocol, 'acp')
  assert.equal(driver.descriptor.capabilities.authMode, 'host-identity')
})

test('Cursor turn plan parity snapshots stay stable for permissions/MCP/endpoint', () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'cctask-cursor-parity-'))
  try {
    const conversation = buildCursorTurnPlan(
      {
        ...baseInput({
          runtimeRoot,
          mcpUrl: 'http://127.0.0.1:9/mcp',
          capabilityProfile: 'chat-write'
        })
      },
      { outerSandbox: false, approveMcps: true }
    )
    const planner = buildCursorTurnPlan(
      {
        ...baseInput({
          role: 'planner',
          runtimeRoot,
          mcpUrl: 'http://127.0.0.1:9/mcp',
          capabilityProfile: 'planner-read'
        })
      },
      { outerSandbox: false }
    )
    const task = buildCursorTurnPlan(
      {
        ...baseInput({
          role: 'task-worker',
          runtimeRoot,
          mcpUrl: 'http://127.0.0.1:9/mcp'
        })
      },
      { outerSandbox: true, endpoint: 'https://api.example' }
    )

    assert.equal(conversation.outerSandbox, false)
    assert.ok(conversation.cliArgs.includes('--approve-mcps'))
    assert.equal(conversation.mcpServers[0]?.name, 'codeteam-manager')

    assert.deepEqual(planner.cliArgs.slice(0, 2), ['--mode', 'ask'])
    assert.equal(planner.cliArgs.includes('--approve-mcps'), false)

    assert.equal(task.outerSandbox, true)
    assert.ok(task.cliArgs.includes('--sandbox'))
    assert.deepEqual(task.cliArgs.slice(0, 2), ['-e', 'https://api.example'])

    assert.deepEqual(buildCursorAcpCliArgs({ outerSandbox: false, approveMcps: false }), ['acp'])
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})
