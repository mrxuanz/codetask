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
import { CODEX_DESCRIPTOR } from '../../src/shared/providers/descriptors/codex.ts'
import { DEFAULT_PROVIDERS_CONFIG } from '../../src/shared/providers/settings.ts'
import type { ProviderInstallation } from '../../src/shared/providers/installation.ts'
import type { AgentTurnChunk, AgentTurnInput } from '../../src/server/agent-runtime/types.ts'
import { buildProviderTurnContext } from '../../src/server/providers/driver.ts'
import { resolveProviderExecutable } from '../../src/server/providers/executable.ts'
import { createProviderRegistry } from '../../src/server/providers/composition.ts'
import { CodexDriver, createCodexStreamFactory } from '../../src/server/providers/codex/driver.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

const installation: ProviderInstallation = Object.freeze({
  id: 'codex:test-delegation',
  provider: 'codex',
  command: 'codex',
  source: 'path',
  invocation: Object.freeze({ executable: '/bin/codex', prefixArgs: Object.freeze([]) }),
  resolvedPath: '/bin/codex',
  canonicalPath: '/bin/codex'
})

function baseInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    provider: 'codex',
    role: 'conversation',
    cwd: '/workspace',
    runtimeRoot: '/runtime/codex',
    prompt: 'delegate-me',
    ...overrides
  }
}

test('CodexDriver shell uses shared Codex descriptor and production kind', () => {
  const driver = new CodexDriver(DEFAULT_PROVIDERS_CONFIG.codex)
  assert.equal(driver.kind, 'production')
  assert.equal(driver.descriptor, CODEX_DESCRIPTOR)
  assert.equal(driver.descriptor.code, 'codex')
  assert.equal(driver.settings, DEFAULT_PROVIDERS_CONFIG.codex)
})

test('CodexDriver prepareTurn delegates to stream factory without altering chunks', async () => {
  const seen: Array<{ prompt: string; outerSandbox: boolean | undefined }> = []
  async function* factory(
    input: AgentTurnInput,
    options?: { outerSandbox?: boolean }
  ): AsyncGenerator<AgentTurnChunk> {
    seen.push({ prompt: input.prompt, outerSandbox: options?.outerSandbox })
    yield { type: 'delta', content: 'hi' }
    yield { type: 'completed', reply: 'hi', runtimeSessionId: 'sess-1' }
  }

  const driver = new CodexDriver(DEFAULT_PROVIDERS_CONFIG.codex, factory)
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

test('default Codex stream factory delegates to legacy streamCodexTurn', () => {
  const source = readFileSync(join(root, 'src/server/providers/codex/driver.ts'), 'utf8')
  assert.match(source, /createCodexStreamFactory/)
  assert.match(source, /streamCodexTurn/)
  assert.match(source, /agent-runtime\/providers\/codex-sdk/)
  assert.equal(typeof createCodexStreamFactory, 'function')
})

test('Registry Codex entry uses the shared descriptor without a parallel runtime catalog', () => {
  const descriptorSource = readFileSync(
    join(root, 'src/server/providers/codex/descriptor.ts'),
    'utf8'
  )
  assert.equal(existsSync(join(root, 'src/server/providers/catalog.ts')), false)
  assert.equal(createProviderRegistry().get('codex').descriptor, CODEX_DESCRIPTOR)
  assert.doesNotMatch(descriptorSource, /label:|description:|defaultCommands:/)
})

test('CodexDriver.discover returns a stable installationId matching the resolver', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cctask-codex-discover-'))
  const bin = join(dir, 'codex-discovered')
  writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  chmodSync(bin, 0o755)

  try {
    const settings = {
      enabled: true,
      executable: { mode: 'path' as const, path: bin },
      approveMcps: false
    }
    const driver = new CodexDriver(settings)
    const hostEnvironment = Object.freeze({ PATH: '/usr/bin' })
    const first = await driver.discover({ hostEnvironment, installDirs: [] })
    const second = await driver.discover({ hostEnvironment, installDirs: [] })
    const viaResolver = resolveProviderExecutable('codex', {
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
    assert.equal(first.provider, 'codex')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('central preflight switch no longer handles Codex; driver owns preflight', () => {
  const driverSource = readFileSync(join(root, 'src/server/providers/codex/driver.ts'), 'utf8')
  const codexPreflight = readFileSync(join(root, 'src/server/providers/codex/preflight.ts'), 'utf8')

  assert.equal(existsSync(join(root, 'src/server/sandbox/provider-auth/preflight.ts')), false)
  assert.equal(existsSync(join(root, 'src/server/providers/provider-subsystem.ts')), false)
  assert.match(driverSource, /runCodexAuthPreflight/)
  assert.match(driverSource, /preflight:\s*\(context\)/)
  assert.match(codexPreflight, /export function runCodexAuthPreflight/)
  assert.doesNotMatch(codexPreflight, /resolveProviderExecutable/)
})

test('buildCodexTurnPlan lives in Codex driver module; runner does not import policy', () => {
  const turnPlan = readFileSync(join(root, 'src/server/providers/codex/turn-plan.ts'), 'utf8')
  const sdk = readFileSync(join(root, 'src/server/agent-runtime/providers/codex-sdk.ts'), 'utf8')
  const runner = readFileSync(join(root, 'src/server/agent-runtime/runner.ts'), 'utf8')
  const driverSource = readFileSync(join(root, 'src/server/providers/codex/driver.ts'), 'utf8')

  assert.match(turnPlan, /export function buildCodexTurnPlan/)
  assert.match(sdk, /from '\.\.\/\.\.\/providers\/codex\/turn-plan'/)
  assert.doesNotMatch(sdk, /from '\.\/codex-policy'/)
  assert.doesNotMatch(runner, /codex-policy|buildCodexTurnPlan/)
  assert.equal(existsSync(join(root, 'src/server/agent-runtime/providers/codex-policy.ts')), false)
  assert.match(driverSource, /export \{\s*buildCodexTurnPlan/s)
})

test('detect installation path is passed to SDK as codexPathOverride with same installationId', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cctask-codex-path-override-'))
  const bin = join(dir, 'codex-sdk-path')
  writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  chmodSync(bin, 0o755)

  try {
    const settings = {
      enabled: true,
      executable: { mode: 'path' as const, path: bin },
      approveMcps: false
    }
    const driver = new CodexDriver(settings)
    const discovered = await driver.discover({
      hostEnvironment: Object.freeze({ PATH: '/usr/bin' }),
      installDirs: []
    })
    assert.ok(discovered)

    const { buildCodexTurnPlan } = await import('../../src/server/providers/codex/turn-plan.ts')
    const plan = buildCodexTurnPlan({
      provider: 'codex',
      role: 'conversation',
      cwd: '/workspace',
      runtimeRoot: dir,
      prompt: 'hi',
      installation: discovered
    })

    assert.equal(plan.installationId, discovered.id)
    assert.equal(plan.codexPathOverride, discovered.invocation.executable)
    assert.equal(plan.codexPathOverride, bin)

    const sdk = readFileSync(join(root, 'src/server/agent-runtime/providers/codex-sdk.ts'), 'utf8')
    assert.match(sdk, /codexPathOverride:\s*plan\.codexPathOverride/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CodexDriver turn handle uses RuntimeManager cancel/close contract', async () => {
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

  const driver = new CodexDriver(DEFAULT_PROVIDERS_CONFIG.codex, factory)
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

  const cancelReason = new Error('codex-cancel')
  const pending = handleIter.next().then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason })
  )
  await prepared.cancel(cancelReason)
  const outcome = await pending
  assert.equal(outcome.status, 'rejected')
  assert.match(String(outcome.reason), /codex-cancel/)
  assert.ok(events.includes('aborted'))
  await prepared.close()
  await prepared.close()

  const manager = new ProviderRuntimeManager()
  async function* completingFactory(): AsyncGenerator<AgentTurnChunk> {
    yield { type: 'delta', content: 'a' }
    yield { type: 'completed', reply: 'a', runtimeSessionId: 's1' }
  }
  const completingDriver = new CodexDriver(DEFAULT_PROVIDERS_CONFIG.codex, completingFactory)
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

  const routing = readFileSync(join(root, 'src/server/agent-runtime/providers/index.ts'), 'utf8')
  assert.match(routing, /getProviderRuntimeManager\(\)\.stream/)
  assert.match(routing, /buildProviderTurnContext/)
})
