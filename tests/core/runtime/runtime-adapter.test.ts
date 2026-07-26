import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  RUNTIME_ADAPTER_PROTECTED_ENTRY,
  RuntimeAdapter,
  assertModulesAbi,
  assertNodeHash,
  assertPortNotReserved,
  allocateEphemeralPort,
  assertMcpEndpointAllowed,
  compileEffectivePolicy,
  isLocalhostMcpAllowed,
  isSoleProtectedRuntimeEntry,
  loadNativeNode,
  NativeLoadError,
  PortAllocationError,
  RESERVED_FIXED_PORTS,
  McpAllowlistError
} from '../../../src/server/adapters/runtime/index.ts'

describe('runtime adapter Wave 7B', () => {
  it('fail closed when .node / addon dir is missing', async () => {
    const missingDir = join(tmpdir(), `codetask-missing-native-${Date.now()}`)
    const adapter = new RuntimeAdapter({
      nodeLoader: { addonDir: missingDir },
      workspace: {
        cwd: '/tmp/ws',
        runtimeRoot: '/tmp/rt'
      },
      providerProfile: { providerCode: 'fake' }
    })

    await assert.rejects(
      () => adapter.openTurn({ jobId: 'job-1', providerCode: 'fake' }),
      (error: unknown) => {
        assert.ok(error instanceof NativeLoadError)
        assert.equal(error.code, 'runtime.native.missing')
        return true
      }
    )
  })

  it('fail closed on ABI mismatch', () => {
    assert.throws(
      () => assertModulesAbi('99999', process.versions.modules),
      (error: unknown) => {
        assert.ok(error instanceof NativeLoadError)
        assert.equal(error.code, 'runtime.native.abi_mismatch')
        return true
      }
    )
  })

  it('fail closed on hash mismatch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codetask-hash-'))
    const nodePath = join(dir, 'dummy.node')
    writeFileSync(nodePath, 'not-a-real-binding')
    assert.throws(
      () => assertNodeHash(nodePath, '0'.repeat(64)),
      (error: unknown) => {
        assert.ok(error instanceof NativeLoadError)
        assert.equal(error.code, 'runtime.native.hash_mismatch')
        return true
      }
    )
  })

  it('openTurn is the sole protected runtime entry', async () => {
    assert.equal(
      isSoleProtectedRuntimeEntry(RUNTIME_ADAPTER_PROTECTED_ENTRY),
      true
    )
    assert.equal(isSoleProtectedRuntimeEntry('child_process.spawn'), false)

    const fakeBinding = {
      addonDir: '/virtual',
      nodePath: '/virtual/codeteam-sandbox.node',
      sha256: 'abc',
      modulesAbi: process.versions.modules,
      binding: {
        preflight() {},
        launchSandboxedWorker() {
          return {}
        }
      }
    }

    const adapter = new RuntimeAdapter({
      native: fakeBinding,
      workspace: {
        cwd: '/tmp/ws',
        runtimeRoot: '/tmp/rt'
      },
      providerProfile: { providerCode: 'fake' },
      dryRun: true
    })

    assert.equal(adapter.protectedEntry, RUNTIME_ADAPTER_PROTECTED_ENTRY)
    const { turnId } = await adapter.openTurn({
      jobId: 'job-sole',
      providerCode: 'fake'
    })
    assert.match(turnId, /^rt-/)
    const supervised = adapter.getSupervisor().get(turnId)
    assert.ok(supervised)
    assert.equal(supervised.status, 'running')
    assert.equal(supervised.jobId, 'job-sole')
  })

  it('live openTurn returns a child after native verify', async () => {
    const fakeBinding = {
      addonDir: '/virtual',
      nodePath: '/virtual/codeteam-sandbox.node',
      sha256: 'live',
      modulesAbi: process.versions.modules,
      binding: {
        preflight() {},
        launchSandboxedWorker() {
          return {}
        }
      }
    }

    const adapter = new RuntimeAdapter({
      native: fakeBinding,
      workspace: {
        cwd: process.cwd(),
        runtimeRoot: process.cwd()
      },
      providerProfile: { providerCode: 'fake' },
      dryRun: false
    })

    const result = await adapter.openTurn({
      jobId: 'job-live',
      providerCode: 'fake',
      invocation: { executable: process.execPath, prefixArgs: [] },
      args: ['-e', 'process.exit(0)'],
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      stdio: 'ignore'
    })

    assert.match(result.turnId, /^rt-/)
    assert.ok(result.child, 'live openTurn must return child')
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      result.child!.once('exit', (code: unknown) => {
        resolve(typeof code === 'number' ? code : null)
      })
      result.child!.once('error', reject)
    })
    assert.equal(exitCode, 0)
    const supervised = adapter.getSupervisor().get(result.turnId)
    assert.ok(supervised)
    assert.ok(supervised.pid == null || typeof supervised.pid === 'number')
  })

  it('port allocator uses ephemeral ports and refuses 5173', async () => {
    assert.ok(RESERVED_FIXED_PORTS.has(5173))
    assert.throws(
      () => assertPortNotReserved(5173),
      (error: unknown) => {
        assert.ok(error instanceof PortAllocationError)
        assert.equal(error.code, 'runtime.port.reserved')
        return true
      }
    )

    const port = await allocateEphemeralPort('127.0.0.1')
    assert.ok(port > 0)
    assert.notEqual(port, 5173)
    assertPortNotReserved(port)
  })

  it('localhost MCP allowlist default denies undeclared endpoints', () => {
    assert.equal(
      isLocalhostMcpAllowed('http://127.0.0.1:9100/mcp', []),
      false
    )
    assert.equal(
      isLocalhostMcpAllowed('http://127.0.0.1:9100/mcp', [
        'http://127.0.0.1:9100/mcp'
      ]),
      true
    )
    assert.throws(
      () =>
        assertMcpEndpointAllowed('http://127.0.0.1:9200/mcp', [
          'http://127.0.0.1:9100/mcp'
        ]),
      (error: unknown) => {
        assert.ok(error instanceof McpAllowlistError)
        assert.equal(error.code, 'runtime.mcp.denied')
        return true
      }
    )
  })

  it('policy compiler merges provider + workspace + mcp + limits', () => {
    const policy = compileEffectivePolicy({
      provider: {
        providerCode: 'opencode',
        identityReadRoots: ['/home/user/.config/opencode'],
        networkMode: 'restricted'
      },
      workspace: {
        cwd: '/work',
        runtimeRoot: '/runtime/task-1',
        writeRoots: ['/work'],
        role: 'task-worker'
      },
      mcp: { allowedEndpoints: ['http://127.0.0.1:9100/mcp'] },
      limits: { maxStdoutBytes: 4096, timeoutMs: 30_000 }
    })

    assert.equal(policy.version, 2)
    assert.equal(policy.providerCode, 'opencode')
    assert.ok(policy.filesystem.allowedReadRoots.includes('/work'))
    assert.ok(
      policy.filesystem.allowedReadRoots.includes('/home/user/.config/opencode')
    )
    assert.ok(policy.filesystem.allowedWriteRoots.includes('/work'))
    assert.deepEqual(policy.network.mcpAllowlist, [
      'http://127.0.0.1:9100/mcp'
    ])
    assert.equal(policy.limits.maxStdoutBytes, 4096)
    assert.equal(policy.limits.timeoutMs, 30_000)
  })

  it('loadNativeNode fails closed when index.js exists but .node is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codetask-addon-'))
    writeFileSync(join(dir, 'index.js'), 'module.exports = {}')
    // Intentionally do not create platform .node
    assert.throws(
      () =>
        loadNativeNode({
          addonDir: dir,
          platform: process.platform,
          arch: process.arch
        }),
      (error: unknown) => {
        assert.ok(error instanceof NativeLoadError)
        assert.equal(error.code, 'runtime.native.missing')
        return true
      }
    )
  })

  it('loadNativeNode succeeds against repo packaged binding when present', () => {
    const repoAddon = join(process.cwd(), 'native', 'codeteam-sandbox')
    try {
      mkdirSync(repoAddon, { recursive: true })
    } catch {
      // exists
    }
    // Only assert success path when the real .node is present (dev machines).
    try {
      const loaded = loadNativeNode({
        addonDir: repoAddon,
        expectedModulesAbi: process.versions.modules
      })
      assert.equal(typeof loaded.binding.preflight, 'function')
      assert.equal(typeof loaded.binding.launchSandboxedWorker, 'function')
      assert.match(loaded.sha256, /^[a-f0-9]{64}$/)
    } catch (error) {
      if (error instanceof NativeLoadError && error.code === 'runtime.native.missing') {
        // CI without built .node still satisfies fail-closed coverage above.
        return
      }
      throw error
    }
  })
})
