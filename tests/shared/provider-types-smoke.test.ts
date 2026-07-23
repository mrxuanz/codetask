import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SUPPORTED_CORE_CODES,
  isSupportedCoreCode,
  PROVIDER_CLI_CANDIDATES,
  resolveProviderExecutable,
  snapshotHostEnv,
  stripCodeTaskTransientEnv,
  applyProviderOverlay,
  buildLaunchEnv,
  buildLaunchSpec,
  defaultEnvironmentCompiler,
  spawnProviderProcess,
  SANDBOX_CANCELLED_EXIT_CODE,
  signalToShellExitCode
} from '../../src/server/providers/index.ts'

test('providers index exports core types and helpers', () => {
  assert.ok(Array.isArray(SUPPORTED_CORE_CODES))
  assert.equal(SUPPORTED_CORE_CODES.length, 4)
  assert.equal(isSupportedCoreCode('codex'), true)
  assert.equal(isSupportedCoreCode('not-a-provider'), false)

  assert.ok(PROVIDER_CLI_CANDIDATES.codex)
  assert.equal(typeof resolveProviderExecutable, 'function')
  assert.equal(typeof snapshotHostEnv, 'function')
  assert.equal(typeof stripCodeTaskTransientEnv, 'function')
  assert.equal(typeof applyProviderOverlay, 'function')
  assert.equal(typeof buildLaunchEnv, 'function')
  assert.equal(typeof buildLaunchSpec, 'function')
  assert.equal(typeof defaultEnvironmentCompiler.compile, 'function')
  assert.equal(typeof spawnProviderProcess, 'function')
  assert.equal(SANDBOX_CANCELLED_EXIT_CODE, -1)
  assert.equal(signalToShellExitCode('SIGTERM'), 143)
})
