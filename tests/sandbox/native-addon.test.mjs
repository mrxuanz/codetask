import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test, { describe as nodeDescribe, it } from 'node:test'
import {
  createSandboxFixture,
  expectedBackend,
  loadNative,
  policyForRoleV2,
  runInSandbox,
  sandboxTestsEnabled,
  sha256Policy
} from './sandbox-test-utils.mjs'

const gate = sandboxTestsEnabled()
const describe = gate.enabled ? nodeDescribe : nodeDescribe.skip

describe('native addon loads and exposes required exports', () => {
  it('exports preflight, launchSandboxedWorker, helperVersion', () => {
    const native = loadNative()
    assert.equal(typeof native.preflight, 'function')
    assert.equal(typeof native.launchSandboxedWorker, 'function')
    assert.equal(typeof native.helperVersion, 'function')
    assert.equal(typeof native.resolveHelperPath, 'function')
  })

  it('resolveHelperPath points at an existing helper binary', () => {
    const native = loadNative()
    const helperPath = native.resolveHelperPath()
    assert.ok(typeof helperPath === 'string' && helperPath.length > 0)
    assert.ok(existsSync(helperPath), `helper missing at ${helperPath}`)
  })

  it('helperVersion returns non-empty semver-like string', () => {
    const native = loadNative()
    const version = native.helperVersion()
    assert.match(String(version), /\d+\.\d+/)
  })

  it('preflight succeeds on current platform', () => {
    const native = loadNative()
    assert.doesNotThrow(() => native.preflight())
  })
})

describe('launchSandboxedWorker attestation contract', () => {
  it('returns active evidence with matching policy hash and platform backend', async (t) => {
    const native = loadNative()
    native.preflight()
    const fixture = createSandboxFixture('codeteam-native-addon-')
    t.after(() => fixture.cleanup())

    const policy = policyForRoleV2('task-worker', fixture.workspace, fixture.runtime)
    const result = await runInSandbox(
      native,
      policy,
      process.platform === 'win32' ? 'echo attested' : 'echo attested'
    )

    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.evidence.active, true)
    assert.equal(result.evidence.policySha256, sha256Policy(policy))
    const backend = expectedBackend()
    if (backend) {
      assert.equal(result.evidence.backend, backend)
    }
    assert.ok(result.evidence.sandboxPid > 0)
  })

  it('SandboxChild exposes pid before exit', async (t) => {
    const native = loadNative()
    native.preflight()
    const fixture = createSandboxFixture('codeteam-native-pid-')
    t.after(() => fixture.cleanup())

    const policy = policyForRoleV2('planner', fixture.workspace, fixture.runtime)
    const shell = process.platform === 'win32' ? 'cmd.exe' : 'sh'
    const shellArgs =
      process.platform === 'win32' ? ['/c', 'echo pid-test'] : ['-lc', 'echo pid-test']

    const handle = native.launchSandboxedWorker({
      policyJson: JSON.stringify({
        version: 2,
        role: policy.role,
        cwd: policy.cwd,
        runtime_root: policy.runtimeRoot,
        filesystem: {
          default_access: policy.filesystem.defaultAccess,
          allowed_read_roots: policy.filesystem.allowedReadRoots,
          allowed_write_roots: policy.filesystem.allowedWriteRoots,
          protected_names: policy.filesystem.protectedNames,
          allow_system_runtime: policy.filesystem.allowSystemRuntime
        },
        network: {
          mode: policy.network.mode,
          allow_loopback: policy.network.allowLoopback,
          allow_unix_sockets: policy.network.allowUnixSockets
        },
        process: {
          isolate_from_host: policy.process.isolateFromHost,
          allow_own_descendant_signals: policy.process.allowOwnDescendantSignals,
          deny_ptrace: policy.process.denyPtrace
        }
      }),
      command: shell,
      args: shellArgs,
      cwd: policy.cwd,
      env: [{ key: 'CODETASK_OUTER_SANDBOX', value: '1' }]
    })

    assert.ok(handle.pid > 0)
    handle.endStdin()
    assert.ok(handle.waitForAttestation(15_000))
    assert.equal(handle.evidence.active, true)
    handle.close()
  })
})

if (!gate.enabled) {
  test('native addon integration skipped', { skip: false }, (t) => {
    t.diagnostic(gate.reason)
  })
}
