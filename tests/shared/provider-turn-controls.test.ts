import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { buildProviderTurnContext } from '../../src/server/providers/driver.ts'
import { defaultEnvironmentCompiler } from '../../src/server/providers/environment.ts'
import type { AgentTurnInput } from '../../src/server/agent-runtime/types.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

function baseInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    provider: 'codex',
    role: 'conversation',
    cwd: '/workspace',
    runtimeRoot: '/runtime/a',
    prompt: 'hello',
    ...overrides
  }
}

test('buildProviderTurnContext carries controls without reading process.env', () => {
  const previousOuter = process.env.CODETASK_OUTER_SANDBOX
  const previousAuth = process.env.CODETASK_PROVIDER_AUTH_MODE
  const previousRoot = process.env.CODETASK_RUNTIME_ROOT
  process.env.CODETASK_OUTER_SANDBOX = '1'
  process.env.CODETASK_PROVIDER_AUTH_MODE = 'runtime-copy'
  process.env.CODETASK_RUNTIME_ROOT = '/should-not-win'

  try {
    const context = buildProviderTurnContext({
      input: baseInput({ runtimeRoot: '/runtime/explicit' }),
      options: { outerSandbox: false },
      authMode: 'host-identity'
    })
    assert.equal(context.controls.runtimeRoot, '/runtime/explicit')
    assert.equal(context.controls.outerSandbox, false)
    assert.equal(context.controls.authMode, 'host-identity')
  } finally {
    if (previousOuter === undefined) delete process.env.CODETASK_OUTER_SANDBOX
    else process.env.CODETASK_OUTER_SANDBOX = previousOuter
    if (previousAuth === undefined) delete process.env.CODETASK_PROVIDER_AUTH_MODE
    else process.env.CODETASK_PROVIDER_AUTH_MODE = previousAuth
    if (previousRoot === undefined) delete process.env.CODETASK_RUNTIME_ROOT
    else process.env.CODETASK_RUNTIME_ROOT = previousRoot
  }
})

test('PreparedProviderTurn forwards controls.runtimeRoot and controls.outerSandbox', () => {
  const source = readFileSync(join(root, 'src/server/providers/delegating-driver.ts'), 'utf8')
  assert.match(source, /runtimeRoot:\s*input\.turn\.controls\.runtimeRoot/)
  assert.match(source, /outerSandbox:\s*input\.turn\.controls\.outerSandbox/)
})

test('registry streamTurn builds ProviderTurnContext with descriptor authMode', () => {
  const source = readFileSync(join(root, 'src/server/agent-runtime/providers/index.ts'), 'utf8')
  assert.match(source, /buildProviderTurnContext/)
  assert.match(source, /authMode:\s*driver\.descriptor\.capabilities\.authMode/)
})

test('EnvironmentCompiler strips internal control keys from child env', () => {
  const env = defaultEnvironmentCompiler.compile({
    provider: 'codex',
    hostEnvironment: Object.freeze({
      PATH: '/usr/bin',
      CODETASK_PROVIDER_AUTH_MODE: 'runtime-copy',
      CODETASK_OUTER_SANDBOX: '1',
      CODETASK_RUNTIME_ROOT: '/runtime'
    })
  })
  assert.equal('CODETASK_PROVIDER_AUTH_MODE' in env, false)
  assert.equal('CODETASK_OUTER_SANDBOX' in env, false)
  assert.equal('CODETASK_RUNTIME_ROOT' in env, false)
  assert.equal(env.PATH, '/usr/bin')
})
