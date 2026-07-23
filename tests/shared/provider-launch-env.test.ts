import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyProviderOverlay,
  buildLaunchEnv,
  snapshotHostEnv
} from '../../src/server/providers/launch-env.ts'

test('buildLaunchEnv returns independent object refs', () => {
  const host = { FOO: 'bar', CODETASK_TASK_IDEMPOTENCY_KEY: 'drop-me' }
  const a = buildLaunchEnv({ provider: 'codex', hostEnv: host })
  const b = buildLaunchEnv({ provider: 'codex', hostEnv: host })
  assert.notEqual(a, b)
})

test('mutating one buildLaunchEnv result does not affect another', () => {
  const host = { SHARED: '1' }
  const a = buildLaunchEnv({ provider: 'codex', hostEnv: host })
  const b = buildLaunchEnv({ provider: 'codex', hostEnv: host })
  a.SHARED = 'mutated'
  assert.equal(b.SHARED, '1')
})

test('buildLaunchEnv does not write process.env', () => {
  const key = 'CODETASK_LAUNCH_ENV_TEST_KEY'
  const previous = process.env[key]
  delete process.env[key]

  const hostSnapshot = snapshotHostEnv()
  buildLaunchEnv({
    provider: 'codex',
    hostEnv: hostSnapshot,
    providerOverlay: { OPENAI_API_KEY: '/tmp/fake-codex' },
    taskOverlay: { [key]: 'task-value' }
  })

  assert.equal(process.env[key], previous)
  if (previous === undefined) delete process.env[key]
})

test('absent CODEX_HOME stays absent in launch env', () => {
  const host: Record<string, string> = { PATH: '/usr/bin' }
  delete host.CODEX_HOME
  const env = buildLaunchEnv({ provider: 'codex', hostEnv: host })
  assert.equal('CODEX_HOME' in env, false)
})

test('applyProviderOverlay rejects non-owned keys', () => {
  const base = { OPENAI_API_KEY: 'host' }
  const out = applyProviderOverlay('codex', base, {
    OPENAI_API_KEY: 'overlay',
    NOT_OWNED_KEY: 'should-not-appear'
  })
  assert.equal(out.OPENAI_API_KEY, 'overlay')
  assert.equal('NOT_OWNED_KEY' in out, false)
})
