import assert from 'node:assert/strict'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, normalize, dirname } from 'node:path'
import test from 'node:test'
import { prepareProviderRuntimeForTest } from '../helpers/provider-runtime'
import { prepareCodexRuntimeProfile } from '../../src/server/sandbox/provider-auth/bridge'
import {
  resolveClaudeHostConfigDir,
  resolveCodexHostHome,
  resolveCursorHostAuthPath,
  resolveCursorHostConfigDir,
  resolveHostProfilePaths,
  resolveOpencodeHostConfigDir,
  resolveOpencodeHostDataDir,
  resolveOpencodeHostStateDir
} from '../../src/server/sandbox/provider-auth/paths'
import {
  PROVIDER_RUNTIME_PROFILE_SCHEMA_VERSION,
  providerRuntimeReadRoots,
  providerRuntimeWriteRoots
} from '../../src/server/sandbox/provider-auth/types'

const PROVIDERS = ['codex', 'cursorcli', 'claude-code', 'opencode'] as const

function createHostIdentityFixture(hostRoot: string): {
  readonly hostEnvironment: Readonly<Record<string, string>>
  readonly credentialFiles: readonly string[]
} {
  const hostEnvironment = Object.freeze({
    HOME: hostRoot,
    USERPROFILE: hostRoot,
    APPDATA: join(hostRoot, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(hostRoot, 'AppData', 'Local'),
    TMPDIR: join(hostRoot, 'tmp')
  })
  const host = resolveHostProfilePaths(hostEnvironment)
  const credentialFiles = [
    join(resolveCodexHostHome(host), 'auth.json'),
    resolveCursorHostAuthPath(host),
    join(resolveClaudeHostConfigDir(host), '.credentials.json'),
    join(resolveOpencodeHostDataDir(host), 'auth.json')
  ]
  for (const path of credentialFiles) {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '{"fixture":"host-identity"}\n', 'utf8')
  }
  return { hostEnvironment, credentialFiles }
}

function listRuntimeFiles(root: string): string[] {
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      assert.equal(lstatSync(path).isSymbolicLink(), false, `runtime symlink forbidden: ${path}`)
      if (entry.isDirectory()) visit(path)
      else files.push(path)
    }
  }
  visit(root)
  return files
}

test('all Providers compile a versioned native-host runtime profile without credential artifacts', () => {
  const hostRoot = mkdtempSync(join(tmpdir(), 'codetask-profile-host-'))
  const runtimeTree = mkdtempSync(join(tmpdir(), 'codetask-profile-runtime-'))
  const fixture = createHostIdentityFixture(hostRoot)
  const before = fixture.credentialFiles.map((path) => ({
    path,
    content: readFileSync(path, 'utf8'),
    mtimeMs: statSync(path).mtimeMs
  }))

  try {
    for (const provider of PROVIDERS) {
      const runtimeRoot = join(runtimeTree, provider)
      mkdirSync(runtimeRoot)
      const profile = prepareProviderRuntimeForTest(provider, {
        hostEnvironment: fixture.hostEnvironment
      })

      assert.equal(profile.schemaVersion, PROVIDER_RUNTIME_PROFILE_SCHEMA_VERSION)
      assert.equal(profile.provider, provider)
      assert.equal(profile.mode, 'host-identity')
      // Host defaults — TMPDIR is not redirected into the per-turn runtime tree.
      assert.equal(profile.environment.TMPDIR, fixture.hostEnvironment.TMPDIR)
      assert.equal(profile.environment.HOME, hostRoot)
      assert.equal('CURSOR_DATA_DIR' in profile.environment, false)
      assert.equal(profile.diagnostics.authMaterialPresent, true)
      assert.ok(profile.hostPathGrants.length > 0)
      if (provider === 'opencode') {
        const host = resolveHostProfilePaths(fixture.hostEnvironment)
        assert.equal(
          profile.environment.XDG_STATE_HOME,
          dirname(resolveOpencodeHostStateDir(host, process.platform, fixture.hostEnvironment))
        )
      } else {
        assert.equal('XDG_STATE_HOME' in profile.environment, false)
      }
      assert.deepEqual(
        providerRuntimeReadRoots(profile),
        profile.hostPathGrants.map((item) => item.path)
      )
      assert.ok(
        !profile.hostPathGrants.some(
          (item) => normalize(item.path).toLowerCase() === normalize(hostRoot).toLowerCase()
        ),
        `${provider} must never grant the full host HOME`
      )

      const runtimeFiles = listRuntimeFiles(runtimeRoot)
      assert.deepEqual(runtimeFiles, [], `${provider} must not write auth/config projections`)
      assert.equal('CODETASK_PROVIDER_AUTH_MODE' in profile.environment, false)
      assert.equal('CODETASK_RUNTIME_ROOT' in profile.environment, false)
    }

    for (const snapshot of before) {
      assert.equal(readFileSync(snapshot.path, 'utf8'), snapshot.content)
      assert.equal(statSync(snapshot.path).mtimeMs, snapshot.mtimeMs)
    }
  } finally {
    rmSync(hostRoot, { recursive: true, force: true })
    rmSync(runtimeTree, { recursive: true, force: true })
  }
})

test('Provider-native identity paths and private instance state are wired per SDK contract', () => {
  const hostRoot = mkdtempSync(join(tmpdir(), 'codetask-profile-host-'))
  const runtimeTree = mkdtempSync(join(tmpdir(), 'codetask-profile-runtime-'))
  const fixture = createHostIdentityFixture(hostRoot)
  const host = resolveHostProfilePaths(fixture.hostEnvironment)

  try {
    const codex = prepareProviderRuntimeForTest('codex', {
      hostEnvironment: fixture.hostEnvironment
    })
    assert.equal(codex.environment.CODEX_HOME, resolveCodexHostHome(host))
    assert.ok(providerRuntimeWriteRoots(codex).includes(resolveCodexHostHome(host)))

    const cursor = prepareProviderRuntimeForTest('cursorcli', {
      hostEnvironment: fixture.hostEnvironment
    })
    assert.equal(cursor.environment.CURSOR_CONFIG_DIR, resolveCursorHostConfigDir(host))
    assert.equal('CURSOR_DATA_DIR' in cursor.environment, false)
    assert.ok(!providerRuntimeWriteRoots(cursor).includes(join(hostRoot, '.cursor')))

    const claude = prepareProviderRuntimeForTest('claude-code', {
      hostEnvironment: fixture.hostEnvironment
    })
    assert.equal(claude.environment.CLAUDE_CONFIG_DIR, resolveClaudeHostConfigDir(host))
    assert.ok(providerRuntimeWriteRoots(claude).includes(resolveClaudeHostConfigDir(host)))

    const opencode = prepareProviderRuntimeForTest('opencode', {
      hostEnvironment: fixture.hostEnvironment
    })
    assert.equal(
      opencode.environment.XDG_CONFIG_HOME,
      join(resolveOpencodeHostConfigDir(host), '..')
    )
    assert.equal(opencode.environment.XDG_DATA_HOME, join(resolveOpencodeHostDataDir(host), '..'))
    // Cache stays on host defaults; state is pinned to the host XDG state home (not runtime).
    assert.equal('XDG_CACHE_HOME' in opencode.environment, false)
    assert.equal(
      opencode.environment.XDG_STATE_HOME,
      dirname(resolveOpencodeHostStateDir(host, process.platform, fixture.hostEnvironment))
    )
    assert.ok(providerRuntimeWriteRoots(opencode).includes(resolveOpencodeHostDataDir(host)))
    assert.ok(
      providerRuntimeWriteRoots(opencode).includes(
        resolveOpencodeHostStateDir(host, process.platform, fixture.hostEnvironment)
      )
    )
  } finally {
    rmSync(hostRoot, { recursive: true, force: true })
    rmSync(runtimeTree, { recursive: true, force: true })
  }
})

test('two runtime profiles share host identity defaults, never instance-local SDK redirects', () => {
  const hostRoot = mkdtempSync(join(tmpdir(), 'codetask-profile-host-'))
  const runtimeTree = mkdtempSync(join(tmpdir(), 'codetask-profile-runtime-'))
  const fixture = createHostIdentityFixture(hostRoot)

  try {
    for (const provider of PROVIDERS) {
      const firstRoot = join(runtimeTree, `${provider}-one`)
      const secondRoot = join(runtimeTree, `${provider}-two`)
      const first = prepareProviderRuntimeForTest(provider, {
        hostEnvironment: fixture.hostEnvironment
      })
      const second = prepareProviderRuntimeForTest(provider, {
        hostEnvironment: fixture.hostEnvironment
      })

      assert.equal(first.environment.HOME, second.environment.HOME)
      assert.equal(first.environment.TMPDIR, second.environment.TMPDIR)
      assert.equal(first.environment.TMPDIR, fixture.hostEnvironment.TMPDIR)
      assert.deepEqual(first.hostPathGrants, second.hostPathGrants)
      assert.equal('CURSOR_DATA_DIR' in first.environment, false)
      assert.equal('XDG_CACHE_HOME' in first.environment, false)
      if (provider === 'opencode') {
        const host = resolveHostProfilePaths(fixture.hostEnvironment)
        assert.equal(
          first.environment.XDG_STATE_HOME,
          dirname(resolveOpencodeHostStateDir(host, process.platform, fixture.hostEnvironment))
        )
      } else {
        assert.equal('XDG_STATE_HOME' in first.environment, false)
      }
    }
  } finally {
    rmSync(hostRoot, { recursive: true, force: true })
    rmSync(runtimeTree, { recursive: true, force: true })
  }
})

test('configuration files alone are not treated as login identity', () => {
  const hostRoot = mkdtempSync(join(tmpdir(), 'codetask-profile-config-only-'))
  const runtimeTree = mkdtempSync(join(tmpdir(), 'codetask-profile-runtime-'))
  const hostEnvironment = Object.freeze({ HOME: hostRoot, USERPROFILE: hostRoot })
  const host = resolveHostProfilePaths(hostEnvironment)

  try {
    mkdirSync(resolveCursorHostConfigDir(host), { recursive: true })
    writeFileSync(join(resolveCursorHostConfigDir(host), 'cli-config.json'), '{}\n')
    mkdirSync(resolveOpencodeHostConfigDir(host), { recursive: true })
    writeFileSync(join(resolveOpencodeHostConfigDir(host), 'opencode.json'), '{}\n')

    assert.equal(
      prepareProviderRuntimeForTest('cursorcli', {
        hostEnvironment
      }).diagnostics.authMaterialPresent,
      process.platform === 'darwin'
    )
    assert.equal(
      prepareProviderRuntimeForTest('opencode', {
        hostEnvironment
      }).diagnostics.authMaterialPresent,
      false
    )
  } finally {
    rmSync(hostRoot, { recursive: true, force: true })
    rmSync(runtimeTree, { recursive: true, force: true })
  }
})

test('unsupported Provider sandbox platforms fail closed before launch', () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-profile-runtime-'))
  try {
    assert.throws(
      () =>
        prepareCodexRuntimeProfile({
          runtimeRoot,
          hostEnvironment: Object.freeze({ HOME: runtimeRoot }),
          platform: 'freebsd'
        }),
      /provider_runtime\.unsupported_platform/
    )
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})

test('Windows host profile paths use AppData namespaces, not Unix defaults', () => {
  const profile = resolveHostProfilePaths(
    {
      USERPROFILE: 'C:\\Users\\tester',
      APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local'
    },
    'win32'
  )
  assert.equal(resolveOpencodeHostConfigDir(profile, 'win32'), join(profile.appData, 'opencode'))
  assert.equal(resolveOpencodeHostDataDir(profile, 'win32'), join(profile.localAppData, 'opencode'))
  assert.equal(
    resolveOpencodeHostStateDir(profile, 'win32', {}),
    join(profile.localAppData, 'state', 'opencode')
  )
  assert.equal(resolveCursorHostConfigDir(profile, 'win32'), join(profile.appData, 'cursor'))
})
