import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  allocateInstanceDirs,
  assertInstanceDirsIsolated,
  assertWhitelistEscapeDenied,
  cleanupInstanceDirs,
  compileProfileToPolicyInput,
  createClaudeProviderRuntimeProfile,
  createCodexProviderRuntimeProfile,
  createCursorProviderRuntimeProfile,
  createFakeProviderRuntimeProfile,
  createHostIdentityProfile,
  createOpenCodeProviderRuntimeProfile,
  CredentialLeaseStore,
  getPathResolver,
  isPathAllowedByPolicy,
  macosPathResolver,
  linuxPathResolver,
  windowsPathResolver,
  ProfileCompileError,
  PathResolverError,
  type InstanceManifest
} from '../../../src/server/adapters/providers/profile/index.ts'
import {
  createClaudeProviderAdapter,
  createCodexProviderAdapter,
  createCursorProviderAdapter,
  createOpenCodeProviderAdapter
} from '../../../src/server/adapters/providers/index.ts'

function listTsFilesRecursive(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...listTsFilesRecursive(full))
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

const FORBIDDEN_NEW_ADAPTER_TOKENS = ['runtime-copy', 'copy-back', 'materializeCredential'] as const

describe('ProviderRuntimeProfile (Wave 7A)', () => {
  it('resolves precise identity paths without whole HOME (identity without copy)', () => {
    const home = '/Users/codetask-test'
    const roots = macosPathResolver.resolveHostRoots({ HOME: home })
    assert.equal(roots.home, home)

    const codex = macosPathResolver.resolveIdentityPaths('codex', roots)
    assert.ok(codex.credentialFiles.every((p) => p.includes('.codex')))
    assert.ok(!codex.credentialDirs.includes(home))
    assert.ok(!codex.credentialFiles.includes(home))

    assert.throws(
      () => macosPathResolver.assertPrecisePath(home, roots),
      (err: unknown) => err instanceof PathResolverError && err.code === 'profile.path.whole_home_forbidden'
    )

    const runtimeRoot = mkdtempSync(join(tmpdir(), 'ct-profile-'))
    try {
      const dirs = allocateInstanceDirs({
        runtimeRoot,
        provider: 'codex',
        instanceId: 'inst-1',
        materializeFs: true
      })
      const profile = createHostIdentityProfile({
        provider: 'codex',
        resolver: macosPathResolver,
        roots,
        credentialEnvNames: ['CODEX_API_KEY', 'OPENAI_API_KEY']
      })
      const policy = compileProfileToPolicyInput({
        profile,
        instanceDirs: dirs,
        cwd: dirs.home,
        hostHome: home,
        platform: 'darwin'
      })

      assert.equal(policy.credentialCopy, false)
      assert.ok(policy.allowedReadRoots.some((r) => r.endsWith(join('.codex', 'auth.json')) || r.includes('.codex')))
      assert.ok(!policy.allowedReadRoots.includes(home))
      assert.ok(!policy.allowedWriteRoots.includes(home))
      assert.equal(policy.environment.HOME, dirs.home)
      assert.equal(policy.environment.XDG_CONFIG_HOME, dirs.config)
      // Host identity is allowlisted; no auth file materialization into instance.
      const instanceListing = readdirSync(dirs.root)
      assert.ok(!instanceListing.includes('auth.json'))
      assert.ok(instanceListing.includes('manifest.json'))
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true })
    }
  })

  it('provider profile builders return precise paths with credentialCopy false', () => {
    const home = '/home/codetask-builders'
    const env = { HOME: home }
    const roots = linuxPathResolver.resolveHostRoots(env)
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'ct-profile-builders-'))
    try {
      const cases = [
        {
          name: 'opencode',
          profile: createOpenCodeProviderRuntimeProfile({
            resolver: linuxPathResolver,
            roots,
            env
          }),
          adapterProfile: createOpenCodeProviderAdapter().buildRuntimeProfile({
            resolver: linuxPathResolver,
            roots,
            env
          })
        },
        {
          name: 'codex',
          profile: createCodexProviderRuntimeProfile({
            resolver: linuxPathResolver,
            roots,
            env
          }),
          adapterProfile: createCodexProviderAdapter().buildRuntimeProfile({
            resolver: linuxPathResolver,
            roots,
            env
          })
        },
        {
          name: 'claude',
          profile: createClaudeProviderRuntimeProfile({
            resolver: linuxPathResolver,
            roots,
            env
          }),
          adapterProfile: createClaudeProviderAdapter().buildRuntimeProfile({
            resolver: linuxPathResolver,
            roots,
            env
          })
        },
        {
          name: 'cursor',
          profile: createCursorProviderRuntimeProfile({
            resolver: linuxPathResolver,
            roots,
            env
          }),
          adapterProfile: createCursorProviderAdapter().buildRuntimeProfile({
            resolver: linuxPathResolver,
            roots,
            env
          })
        }
      ] as const

      for (const { name, profile, adapterProfile } of cases) {
        assert.equal(profile.provider, name)
        assert.equal(adapterProfile.provider, name)
        const dirs = allocateInstanceDirs({
          runtimeRoot,
          provider: name,
          instanceId: `${name}-1`,
          materializeFs: false
        })
        const policy = compileProfileToPolicyInput({
          profile,
          instanceDirs: dirs,
          cwd: dirs.home,
          hostHome: home,
          platform: 'linux'
        })
        assert.equal(policy.credentialCopy, false, name)
        assert.ok(!policy.allowedReadRoots.includes(home), `${name} must not allow whole HOME`)
        assert.ok(
          profile.filesystem.hostRead.every((cap) => cap.path !== home),
          `${name} hostRead must not include HOME`
        )
        // Cursor specifically: identity dirs are under .cursor / config, not HOME.
        if (name === 'cursor') {
          assert.ok(
            profile.filesystem.hostRead.every(
              (cap) =>
                cap.path.includes('.cursor') ||
                cap.path.includes(`${join('.config', 'cursor')}`) ||
                cap.path.includes('/cursor/')
            ),
            'cursor paths must be precise identity dirs'
          )
        }
      }
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true })
    }
  })

  it('denies whitelist escape for sentinel outside allowlist', () => {
    const home = '/home/codetask-test'
    const roots = linuxPathResolver.resolveHostRoots({ HOME: home })
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'ct-profile-esc-'))
    try {
      const dirs = allocateInstanceDirs({
        runtimeRoot,
        provider: 'opencode',
        instanceId: 'a',
        materializeFs: false
      })
      const profile = createHostIdentityProfile({
        provider: 'opencode',
        resolver: linuxPathResolver,
        roots
      })
      const policy = compileProfileToPolicyInput({
        profile,
        instanceDirs: dirs,
        cwd: dirs.home,
        hostHome: home,
        platform: 'linux'
      })

      const sentinel = join(home, '.ssh', 'id_rsa')
      assert.equal(isPathAllowedByPolicy(policy, sentinel, 'read'), false)
      assert.equal(isPathAllowedByPolicy(policy, sentinel, 'write'), false)
      assertWhitelistEscapeDenied(policy, sentinel, 'read')
      assertWhitelistEscapeDenied(policy, join(home, 'Documents', 'secret.txt'), 'write')
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true })
    }
  })

  it('isolates multi-instance directories (home/data/cache/state/tmp/log/ipc)', () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'ct-profile-multi-'))
    try {
      const a = allocateInstanceDirs({
        runtimeRoot,
        provider: 'claude-code',
        instanceId: 'one',
        materializeFs: true
      })
      const b = allocateInstanceDirs({
        runtimeRoot,
        provider: 'claude-code',
        instanceId: 'two',
        materializeFs: true
      })
      assertInstanceDirsIsolated(a, b)
      assert.notEqual(a.home, b.home)
      assert.notEqual(a.data, b.data)
      assert.notEqual(a.cache, b.cache)
      assert.notEqual(a.state, b.state)
      assert.notEqual(a.tmp, b.tmp)
      assert.notEqual(a.log, b.log)
      assert.notEqual(a.ipc, b.ipc)

      const manifestA = JSON.parse(readFileSync(a.manifestPath, 'utf8')) as {
        ownedPaths: string[]
        root: string
      }
      assert.ok(manifestA.ownedPaths.includes(a.ipc))
      assert.ok(!manifestA.ownedPaths.includes(b.ipc))
      assert.equal(manifestA.root, a.root)
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true })
    }
  })

  it('cleanupInstanceDirs only deletes manifest-owned paths under instance root', () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'ct-profile-cleanup-'))
    try {
      const dirs = allocateInstanceDirs({
        runtimeRoot,
        provider: 'codex',
        instanceId: 'cleanup-1',
        materializeFs: true
      })
      writeFileSync(join(dirs.home, 'session.json'), '{"ok":true}\n', 'utf8')
      writeFileSync(join(dirs.tmp, 'scratch.bin'), 'x', 'utf8')
      const sentinelOutsideOwned = join(dirs.root, 'keep-me.txt')
      writeFileSync(sentinelOutsideOwned, 'preserve\n', 'utf8')
      const hostSentinelDir = mkdtempSync(join(tmpdir(), 'ct-host-sentinel-'))
      const hostSentinel = join(hostSentinelDir, 'host-secret.txt')
      writeFileSync(hostSentinel, 'host\n', 'utf8')

      const manifest = JSON.parse(readFileSync(dirs.manifestPath, 'utf8')) as InstanceManifest
      cleanupInstanceDirs(manifest)

      assert.equal(existsSync(dirs.home), false)
      assert.equal(existsSync(dirs.tmp), false)
      assert.equal(existsSync(dirs.config), false)
      assert.ok(existsSync(sentinelOutsideOwned), 'non-owned path under root must survive')
      assert.ok(existsSync(dirs.manifestPath), 'manifest itself is not an ownedPath')
      assert.ok(existsSync(hostSentinel), 'host paths must never be deleted')

      assert.throws(
        () =>
          cleanupInstanceDirs({
            ...manifest,
            ownedPaths: [...manifest.ownedPaths, hostSentinel]
          }),
        (err: unknown) =>
          err instanceof Error && err.message.includes('profile.instance.cleanup.path_outside_root')
      )
      assert.ok(existsSync(hostSentinel), 'rejected outside path must remain')

      rmSync(hostSentinelDir, { recursive: true, force: true })
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true })
    }
  })

  it('recovers credential leases after crash (expired reclaim + fence)', () => {
    const store = new CredentialLeaseStore()
    const lease1 = store.acquire({
      provider: 'codex',
      accountKey: 'acct-1',
      holderInstanceId: 'inst-crash',
      nowMs: 1_000,
      ttlMs: 5_000
    })

    assert.throws(() =>
      store.acquire({
        provider: 'codex',
        accountKey: 'acct-1',
        holderInstanceId: 'inst-other',
        nowMs: 2_000,
        ttlMs: 5_000
      })
    )

    // Simulate crash: lease expires, sweeper recovers, new holder acquires.
    const recovered = store.recoverExpired(10_000)
    assert.deepEqual(recovered, [lease1.leaseId])

    const lease2 = store.acquire({
      provider: 'codex',
      accountKey: 'acct-1',
      holderInstanceId: 'inst-recovered',
      nowMs: 10_100,
      ttlMs: 5_000
    })
    assert.ok(lease2.fenceToken > lease1.fenceToken)

    assert.throws(() =>
      store.assertWritable('codex', 'acct-1', 'inst-crash', lease1.fenceToken, 10_200)
    )
    store.assertWritable('codex', 'acct-1', 'inst-recovered', lease2.fenceToken, 10_200)
    store.release('codex', 'acct-1', 'inst-recovered', lease2.fenceToken)
    assert.equal(store.get('codex', 'acct-1'), undefined)
  })

  it('fails closed when profile is incomplete', () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'ct-profile-fail-'))
    try {
      const dirs = allocateInstanceDirs({
        runtimeRoot,
        provider: 'fake',
        instanceId: 'x',
        materializeFs: false
      })
      const incomplete = createFakeProviderRuntimeProfile({
        provider: '',
        version: 0
      })
      assert.throws(
        () =>
          compileProfileToPolicyInput({
            profile: incomplete,
            instanceDirs: dirs,
            cwd: dirs.home
          }),
        (err: unknown) => err instanceof ProfileCompileError
      )

      const withWholeHome = createFakeProviderRuntimeProfile({
        filesystem: {
          hostRead: [
            {
              path: '/Users/someone',
              access: 'read',
              purpose: 'credential',
              required: false
            }
          ],
          hostWrite: [],
          instanceReadWrite: ['home']
        }
      })
      assert.throws(
        () =>
          compileProfileToPolicyInput({
            profile: withWholeHome,
            instanceDirs: dirs,
            cwd: dirs.home,
            hostHome: '/Users/someone'
          }),
        (err: unknown) =>
          err instanceof ProfileCompileError && err.code === 'profile.compile.whole_home'
      )
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true })
    }
  })

  it('windows / linux / macos resolvers never return whole profile as identity dir', () => {
    for (const resolver of [macosPathResolver, linuxPathResolver, windowsPathResolver]) {
      // Use absolute POSIX stand-ins so layout logic is testable on Linux CI hosts.
      const env =
        resolver.platform === 'win32'
          ? {
              USERPROFILE: '/win/Users/ct',
              APPDATA: '/win/Users/ct/AppData/Roaming',
              LOCALAPPDATA: '/win/Users/ct/AppData/Local'
            }
          : { HOME: '/home/ct' }
      const roots = resolver.resolveHostRoots(env)
      for (const provider of ['codex', 'claude-code', 'cursorcli', 'opencode'] as const) {
        const identity = resolver.resolveIdentityPaths(provider, roots, env)
        assert.ok(!identity.credentialDirs.includes(roots.home), `${resolver.platform}/${provider}`)
        assert.ok(
          identity.credentialFiles.every((f) => f !== roots.home),
          `${resolver.platform}/${provider} file`
        )
      }
    }
    assert.equal(getPathResolver('darwin').platform, 'darwin')
    assert.equal(getPathResolver('linux').platform, 'linux')
    assert.equal(getPathResolver('win32').platform, 'win32')
  })

  it('Fake profile path has no credential copy mode and credentialCopy=false', () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'ct-profile-fake-'))
    try {
      const dirs = allocateInstanceDirs({
        runtimeRoot,
        provider: 'fake',
        instanceId: 'f1',
        materializeFs: false
      })
      const profile = createFakeProviderRuntimeProfile()
      const policy = compileProfileToPolicyInput({
        profile,
        instanceDirs: dirs,
        cwd: dirs.home,
        platform: 'linux'
      })
      assert.equal(policy.credentialCopy, false)
      assert.ok(profile.credentials.every((c) => c.type === 'environment'))
      assert.equal(policy.environment.HOME, dirs.home)
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true })
    }
  })

  it('NEW adapter production sources forbid runtime-copy, copy-back, materializeCredential', () => {
    const providersRoot = fileURLToPath(
      new URL('../../../src/server/adapters/providers', import.meta.url)
    )
    const files = listTsFilesRecursive(providersRoot)
    assert.ok(files.length > 0, 'expected provider adapter sources')
    const offenders: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const token of FORBIDDEN_NEW_ADAPTER_TOKENS) {
        if (text.includes(token)) {
          offenders.push(`${file}: ${token}`)
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `NEW adapters must not contain forbidden credential-copy tokens:\n${offenders.join('\n')}`
    )
  })
})
