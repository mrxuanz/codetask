import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DefaultEnvironmentCompiler,
  defaultEnvironmentCompiler,
  stripCodeTaskTransientEnv
} from '../../src/server/providers/environment.ts'
import type { HostEnvironmentSnapshot } from '../../src/server/host-environment.ts'

function freezeHost(env: Record<string, string>): HostEnvironmentSnapshot {
  return Object.freeze({ ...env })
}

test('defaultEnvironmentCompiler is the sole DefaultEnvironmentCompiler instance export', () => {
  assert.ok(defaultEnvironmentCompiler instanceof DefaultEnvironmentCompiler)
})

test('EnvironmentCompiler returns independent object refs on each compile', () => {
  const host = freezeHost({
    PATH: '/usr/bin',
    CODETASK_TASK_IDEMPOTENCY_KEY: 'drop-me'
  })
  const a = defaultEnvironmentCompiler.compile({ provider: 'codex', hostEnvironment: host })
  const b = defaultEnvironmentCompiler.compile({ provider: 'codex', hostEnvironment: host })
  assert.notEqual(a, b)
  assert.equal('CODETASK_TASK_IDEMPOTENCY_KEY' in a, false)
  assert.equal('CODETASK_TASK_IDEMPOTENCY_KEY' in b, false)
})

test('mutating one EnvironmentCompiler result does not affect another', () => {
  const host = freezeHost({ SHARED: '1' })
  const a = defaultEnvironmentCompiler.compile({ provider: 'codex', hostEnvironment: host })
  const b = defaultEnvironmentCompiler.compile({ provider: 'codex', hostEnvironment: host })
  a.SHARED = 'mutated'
  assert.equal(b.SHARED, '1')
  assert.equal(host.SHARED, '1')
})

test('EnvironmentCompiler does not write process.env', () => {
  const key = 'CODETASK_ENV_COMPILER_TEST_KEY'
  const previous = process.env[key]
  delete process.env[key]

  defaultEnvironmentCompiler.compile({
    provider: 'codex',
    hostEnvironment: freezeHost({ PATH: '/usr/bin' }),
    providerOverlay: { OPENAI_API_KEY: '/tmp/fake-codex' },
    taskOverlay: { [key]: 'task-value' }
  })

  assert.equal(process.env[key], previous)
  if (previous === undefined) delete process.env[key]
})

test('EnvironmentCompiler never mutates the host snapshot object', () => {
  const host = freezeHost({
    PATH: '/usr/bin',
    CODETASK_RUNTIME_ROOT: '/tmp/runtime',
    OPENAI_API_KEY: 'host-key'
  })
  const before = { ...host }
  const env = defaultEnvironmentCompiler.compile({
    provider: 'codex',
    hostEnvironment: host,
    providerOverlay: { OPENAI_API_KEY: 'overlay-key' },
    taskOverlay: { CODETASK_TASK_IDEMPOTENCY_KEY: 'task-1' }
  })
  assert.deepEqual({ ...host }, before)
  assert.equal(env.OPENAI_API_KEY, 'overlay-key')
  assert.equal(env.CODETASK_TASK_IDEMPOTENCY_KEY, 'task-1')
  assert.equal('CODETASK_RUNTIME_ROOT' in env, false)
})

test('EnvironmentCompiler rejects non-owned provider overlay keys', () => {
  const env = defaultEnvironmentCompiler.compile({
    provider: 'codex',
    hostEnvironment: freezeHost({ OPENAI_API_KEY: 'host' }),
    providerOverlay: {
      OPENAI_API_KEY: 'overlay',
      NOT_OWNED_KEY: 'should-not-appear'
    }
  })
  assert.equal(env.OPENAI_API_KEY, 'overlay')
  assert.equal('NOT_OWNED_KEY' in env, false)
})

test('EnvironmentCompiler does not invent CODEX_HOME when absent from host', () => {
  const host: Record<string, string> = { PATH: '/usr/bin' }
  delete host.CODEX_HOME
  const env = defaultEnvironmentCompiler.compile({
    provider: 'codex',
    hostEnvironment: freezeHost(host)
  })
  assert.equal('CODEX_HOME' in env, false)
})

test('stripCodeTaskTransientEnv returns a new object without parent writes', () => {
  const key = 'CODETASK_RUNTIME_ROOT'
  const previous = process.env[key]
  const input = Object.freeze({ PATH: '/bin', [key]: '/tmp/rt' })
  const out = stripCodeTaskTransientEnv(input)
  assert.notEqual(out, input)
  assert.equal(key in out, false)
  assert.equal(input[key], '/tmp/rt')
  assert.equal(process.env[key], previous)
})
