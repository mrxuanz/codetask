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
import { join, normalize } from 'node:path'
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
  resolveOpencodeHostDataDir
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
    LOCALAPPDATA: join(hostRoot, 'AppData', 'Local')
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
      const profile = prepareProviderRuntimeForTest(provider, runtimeRoot, {
        hostEnvironment: fixture.hostEnvironment
      })

      assert.equal(profile.schemaVersion, PROVIDER_RUNTIME_PROFILE_SCHEMA_VERSION)
      assert.equal(profile.provider, provider)
      assert.equal(profile.mode, 'host-identity')
      assert.equal(profile.runtimeRoot, runtimeRoot)
      assert.equal(profile.stateRoot, runtimeRoot)
      assert.equal(profile.environment.TMPDIR, join(runtimeRoot, 'tmp'))
      assert.equal(profile.diagnostics.authMaterialPresent, true)
      assert.ok(profile.hostPathGrants.length > 0)
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
    const codex = prepareProviderRuntimeForTest('codex', join(runtimeTree, 'codex'), {
      hostEnvironment: fixture.hostEnvironment
    })
    assert.equal(codex.environment.CODEX_HOME, resolveCodexHostHome(host))
    assert.ok(providerRuntimeWriteRoots(codex).includes(resolveCodexHostHome(host)))

    const cursor = prepareProviderRuntimeForTest('cursorcli', join(runtimeTree, 'cursor'), {
      hostEnvironment: fixture.hostEnvironment
    })
    assert.equal(cursor.environment.CURSOR_CONFIG_DIR, resolveCursorHostConfigDir(host))
    assert.equal(cursor.environment.CURSOR_DATA_DIR, join(runtimeTree, 'cursor', '.cursor'))
    assert.ok(!providerRuntimeWriteRoots(cursor).includes(join(hostRoot, '.cursor')))

    const claude = prepareProviderRuntimeForTest('claude-code', join(runtimeTree, 'claude'), {
      hostEnvironment: fixture.hostEnvironment
    })
    assert.equal(claude.environment.CLAUDE_CONFIG_DIR, resolveClaudeHostConfigDir(host))
    assert.ok(providerRuntimeWriteRoots(claude).includes(resolveClaudeHostConfigDir(host)))

    const opencode = prepareProviderRuntimeForTest('opencode', join(runtimeTree, 'opencode'), {
      hostEnvironment: fixture.hostEnvironment
    })
    assert.equal(
      opencode.environment.XDG_CONFIG_HOME,
      join(resolveOpencodeHostConfigDir(host), '..')
    )
    assert.equal(opencode.environment.XDG_DATA_HOME, join(resolveOpencodeHostDataDir(host), '..'))
    assert.equal(opencode.environment.XDG_CACHE_HOME, join(runtimeTree, 'opencode', 'cache'))
    assert.equal(opencode.environment.XDG_STATE_HOME, join(runtimeTree, 'opencode', 'state'))
    assert.ok(providerRuntimeWriteRoots(opencode).includes(resolveOpencodeHostDataDir(host)))
  } finally {
    rmSync(hostRoot, { recursive: true, force: true })
    rmSync(runtimeTree, { recursive: true, force: true })
  }
})

test('two runtime profiles share only explicit host identity grants, never instance state', () => {
  const hostRoot = mkdtempSync(join(tmpdir(), 'codetask-profile-host-'))
  const runtimeTree = mkdtempSync(join(tmpdir(), 'codetask-profile-runtime-'))
  const fixture = createHostIdentityFixture(hostRoot)

  try {
    for (const provider of PROVIDERS) {
      const firstRoot = join(runtimeTree, `${provider}-one`)
      const secondRoot = join(runtimeTree, `${provider}-two`)
      const first = prepareProviderRuntimeForTest(provider, firstRoot, {
        hostEnvironment: fixture.hostEnvironment
      })
      const second = prepareProviderRuntimeForTest(provider, secondRoot, {
        hostEnvironment: fixture.hostEnvironment
      })

      assert.notEqual(first.runtimeRoot, second.runtimeRoot)
      assert.notEqual(first.environment.TMPDIR, second.environment.TMPDIR)
      assert.deepEqual(first.hostPathGrants, second.hostPathGrants)
      for (const value of [
        first.environment.TMPDIR,
        first.environment.XDG_CACHE_HOME,
        first.environment.XDG_STATE_HOME,
        first.environment.CURSOR_DATA_DIR
      ].filter((item): item is string => typeof item === 'string')) {
        assert.ok(value.startsWith(firstRoot), `${provider} leaked first runtime state: ${value}`)
        assert.ok(!value.startsWith(secondRoot))
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
      prepareProviderRuntimeForTest('cursorcli', join(runtimeTree, 'cursor'), {
        hostEnvironment
      }).diagnostics.authMaterialPresent,
      process.platform === 'darwin'
    )
    assert.equal(
      prepareProviderRuntimeForTest('opencode', join(runtimeTree, 'opencode'), {
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
  assert.equal(resolveCursorHostConfigDir(profile, 'win32'), join(profile.appData, 'cursor'))
})
