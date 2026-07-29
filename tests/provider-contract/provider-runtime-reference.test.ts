import assert from 'node:assert/strict'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareProviderAuthForTest } from '../helpers/provider-runtime'
import {
  materializeCodexAuth,
  materializeCursorAuth,
  materializeOpencodeAuth,
  opencodeRuntimeLayout
} from '../../src/server/sandbox/provider-auth/materialize'
import {
  credentialSnapshotManifestPath,
  scrubCredentialSnapshotsInTree
} from '../../src/server/sandbox/provider-auth/snapshot-manifest'
import {
  resolveHostProfilePaths,
  runtimeCodexHome,
  runtimeCursorAuthPath
} from '../../src/server/sandbox/provider-auth/paths'

const RUNTIME_REFERENCE_PROVIDERS = ['codex', 'opencode'] as const

test('runtime-reference providers never receive host write roots', () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-provider-bridge-'))
  const workspaceRoot = join(runtimeRoot, 'workspace')
  try {
    for (const provider of RUNTIME_REFERENCE_PROVIDERS) {
      const prepared = prepareProviderAuthForTest(provider, runtimeRoot, { workspaceRoot })
      assert.equal(prepared.diagnostics.mode, 'runtime-reference', provider)
      assert.equal(prepared.mode, 'runtime-reference', provider)
      assert.equal(prepared.runtimeRoot, runtimeRoot, provider)
      assert.equal('CODETASK_PROVIDER_AUTH_MODE' in prepared.envPatch, false, provider)
      assert.deepEqual(prepared.writeRoots ?? [], [], provider)
      assert.equal(prepared.envPatch.HOME, runtimeRoot, provider)
      assert.equal(prepared.envPatch.CODETASK_DATA_DIR, undefined, provider)
      assert.equal(prepared.filesystemProfile.provider, provider)
      assert.deepEqual(prepared.filesystemProfile.hostReadRoots, prepared.readRoots)
      assert.deepEqual(prepared.filesystemProfile.hostWriteRoots, [])
      assert.deepEqual(prepared.filesystemProfile.runtimeEnv, prepared.envPatch)
      assert.ok(Array.isArray(prepared.filesystemProfile.credentialSnapshots))
      assert.ok(Array.isArray(prepared.filesystemProfile.scrubPatterns))

      const host = resolveHostProfilePaths()
      for (const writeRoot of prepared.writeRoots ?? []) {
        assert.ok(
          !writeRoot.toLowerCase().startsWith(host.home.toLowerCase()),
          `${provider} must not write host home: ${writeRoot}`
        )
      }
    }
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})

test('cursor sandbox uses host-identity and never writes outside allowed roots', () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-cursor-bridge-'))
  const workspaceRoot = join(runtimeRoot, 'workspace')
  mkdirSync(workspaceRoot)
  try {
    const host = resolveHostProfilePaths()
    const prepared = prepareProviderAuthForTest('cursorcli', runtimeRoot, { workspaceRoot })

    assert.equal(prepared.diagnostics.mode, 'host-identity')
    assert.equal(prepared.mode, 'host-identity')
    assert.equal(prepared.runtimeRoot, runtimeRoot)
    assert.equal('CODETASK_PROVIDER_AUTH_MODE' in prepared.envPatch, false)
    assert.equal('CODETASK_RUNTIME_ROOT' in prepared.envPatch, false)
    assert.equal(prepared.envPatch.HOME, host.home)
    assert.equal(prepared.envPatch.CURSOR_DATA_DIR, join(runtimeRoot, '.cursor'))
    assert.deepEqual(prepared.filesystemProfile.hostReadRoots, prepared.readRoots)
    assert.deepEqual(prepared.filesystemProfile.hostWriteRoots, prepared.writeRoots)
    assert.ok(!(prepared.readRoots ?? []).includes(host.home))
    assert.ok(!(prepared.writeRoots ?? []).includes(join(host.home, '.cursor')))
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})

test('Cursor configuration alone is not reported as login material', () => {
  const hostRoot = mkdtempSync(join(tmpdir(), 'codetask-cursor-host-'))
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-cursor-runtime-'))
  const workspaceRoot = join(runtimeRoot, 'workspace')
  const hostProfile = resolveHostProfilePaths({ HOME: hostRoot })

  try {
    mkdirSync(join(hostRoot, '.cursor'), { recursive: true })
    mkdirSync(workspaceRoot)
    writeFileSync(join(hostRoot, '.cursor', 'cli-config.json'), '{"theme":"dark"}', 'utf8')

    const materialized = materializeCursorAuth(runtimeRoot, workspaceRoot, hostProfile)
    assert.equal(materialized.authMaterialized, false)
    assert.equal(materialized.configMaterialized, true)
    assert.equal(materialized.runtimeAuthPath, runtimeCursorAuthPath(runtimeRoot))
    assert.equal(
      lstatSync(join(runtimeRoot, '.cursor', 'cli-config.json')).isSymbolicLink(),
      true
    )
  } finally {
    rmSync(hostRoot, { recursive: true, force: true })
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})

test('codex runtime env sets CODEX_HOME under runtimeRoot', () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-codex-env-'))
  try {
    const prepared = prepareProviderAuthForTest('codex', runtimeRoot)
    assert.equal(prepared.envPatch.CODEX_HOME, runtimeCodexHome(runtimeRoot))
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})

test('materializeCodexAuth generates filtered config.toml without MCP sections', () => {
  const hostRoot = mkdtempSync(join(tmpdir(), 'codetask-codex-host-'))
  const hostCodexHome = join(hostRoot, '.codex')
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-codex-runtime-'))
  const hostProfile = resolveHostProfilePaths({ HOME: hostRoot })

  try {
    mkdirSync(hostCodexHome)
    writeFileSync(
      join(hostCodexHome, 'config.toml'),
      `model = "gpt-test"

[mcp_servers.codeteam]
url = "http://127.0.0.1:1"

[plugins]
enabled = true
`,
      'utf8'
    )

    const result = materializeCodexAuth(runtimeRoot, hostProfile)
    assert.equal(result.configGenerated, true)

    const runtimeConfig = join(runtimeCodexHome(runtimeRoot), 'config.toml')
    assert.ok(existsSync(runtimeConfig))
    const raw = readFileSync(runtimeConfig, 'utf8')
    assert.match(raw, /model = "gpt-test"/)
    assert.doesNotMatch(raw, /mcp_servers/)
    assert.doesNotMatch(raw, /\[plugins\]/)
  } finally {
    rmSync(hostRoot, { recursive: true, force: true })
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})

test('materializeCodexAuth preserves existing session rollouts across turns', () => {
  const hostRoot = mkdtempSync(join(tmpdir(), 'codetask-codex-host-'))
  const hostCodexHome = join(hostRoot, '.codex')
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-codex-runtime-'))
  const hostProfile = resolveHostProfilePaths({ HOME: hostRoot })

  try {
    mkdirSync(hostCodexHome)
    writeFileSync(join(hostCodexHome, 'auth.json'), '{"token":"host"}', 'utf8')
    writeFileSync(join(hostCodexHome, 'config.toml'), 'model = "gpt-test"\n', 'utf8')

    materializeCodexAuth(runtimeRoot, hostProfile)

    const codexHome = runtimeCodexHome(runtimeRoot)
    const rolloutDir = join(codexHome, 'sessions', '019f6434-ebb9-7e10-b5e8-c97e50d202ee')
    const rolloutPath = join(rolloutDir, 'rollout.json')
    mkdirSync(rolloutDir, { recursive: true })
    writeFileSync(rolloutPath, '{"thread":"preserved"}', 'utf8')

    materializeCodexAuth(runtimeRoot, hostProfile)

    assert.equal(readFileSync(rolloutPath, 'utf8'), '{"thread":"preserved"}')
    assert.equal(lstatSync(join(codexHome, 'auth.json')).isSymbolicLink(), true)
    assert.equal(readFileSync(join(codexHome, 'auth.json'), 'utf8'), '{"token":"host"}')
    assert.match(readFileSync(join(codexHome, 'config.toml'), 'utf8'), /model = "gpt-test"/)
  } finally {
    rmSync(hostRoot, { recursive: true, force: true })
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})

test('credential snapshots are manifested and startup scrub removes only recorded runtime files', () => {
  const hostRoot = mkdtempSync(join(tmpdir(), 'codetask-codex-host-'))
  const hostCodexHome = join(hostRoot, '.codex')
  const runtimeTree = mkdtempSync(join(tmpdir(), 'codetask-runtime-tree-'))
  const runtimeRoot = join(runtimeTree, 'thread-1', 'jobs', 'job-1', 'codex')
  const hostProfile = resolveHostProfilePaths({ HOME: hostRoot })

  try {
    mkdirSync(hostCodexHome)
    mkdirSync(runtimeRoot, { recursive: true })
    writeFileSync(join(hostCodexHome, 'auth.json'), '{"token":"host"}', 'utf8')
    writeFileSync(join(hostCodexHome, 'config.toml'), 'model = "gpt-test"\n', 'utf8')

    const materialized = materializeCodexAuth(runtimeRoot, hostProfile)
    const codexHome = runtimeCodexHome(runtimeRoot)
    const sessionPath = join(codexHome, 'sessions', 'keep.json')
    mkdirSync(join(codexHome, 'sessions'), { recursive: true })
    writeFileSync(sessionPath, '{"session":true}', 'utf8')

    assert.equal(materialized.authMaterialized, true)
    assert.equal(materialized.authMaterialization, 'reference')
    assert.equal(lstatSync(join(codexHome, 'auth.json')).isSymbolicLink(), true)
    assert.ok(existsSync(credentialSnapshotManifestPath(runtimeRoot)))

    const scrubbed = scrubCredentialSnapshotsInTree(runtimeTree)
    assert.equal(scrubbed.manifests, 1)
    assert.equal(scrubbed.files, 2)
    assert.equal(existsSync(join(codexHome, 'auth.json')), false)
    assert.equal(existsSync(join(codexHome, 'config.toml')), false)
    assert.equal(readFileSync(sessionPath, 'utf8'), '{"session":true}')
  } finally {
    rmSync(hostRoot, { recursive: true, force: true })
    rmSync(runtimeTree, { recursive: true, force: true })
  }
})

test('prepareClaude whitelists login identity files and rejects settings env credentials', () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-claude-env-'))
  const hostRoot = mkdtempSync(join(tmpdir(), 'codetask-claude-host-'))
  const hostClaude = join(hostRoot, '.claude')

  try {
    mkdirSync(hostClaude)
    writeFileSync(
      join(hostClaude, 'settings.json'),
      JSON.stringify({
        env: {
          ANTHROPIC_API_KEY: 'sk-test',
          PATH: '/should-not-inject',
          HOME: '/should-not-inject'
        }
      }),
      'utf8'
    )

    const prepared = prepareProviderAuthForTest('claude-code', runtimeRoot, {
      hostEnvironment: { HOME: hostRoot }
    })
    assert.equal(prepared.mode, 'host-identity')
    assert.equal(prepared.envPatch.CLAUDE_CONFIG_DIR, undefined)
    assert.equal(prepared.envPatch.HOME, hostRoot)
    assert.equal(prepared.envPatch.ANTHROPIC_API_KEY, undefined)
    assert.notEqual(prepared.envPatch.PATH, '/should-not-inject')
    assert.equal(prepared.diagnostics.authMaterialPresent, false)
    assert.ok(!(prepared.readRoots ?? []).includes(hostClaude))
    assert.ok(!(prepared.readRoots ?? []).includes(join(hostClaude, 'settings.json')))
    assert.ok(!(prepared.writeRoots ?? []).includes(hostClaude))

    writeFileSync(join(hostClaude, '.credentials.json'), '{"oauth":"host"}', 'utf8')
    const withLogin = prepareProviderAuthForTest('claude-code', runtimeRoot, {
      hostEnvironment: { HOME: hostRoot }
    })
    assert.equal(withLogin.diagnostics.authMaterialPresent, true)
    assert.ok((withLogin.readRoots ?? []).includes(join(hostClaude, '.credentials.json')))
  } finally {
    rmSync(hostRoot, { recursive: true, force: true })
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})

test('prepareOpencode aligns XDG env with materializeOpencodeAuth destinations', () => {
  const hostRoot = mkdtempSync(join(tmpdir(), 'codetask-opencode-host-config-'))
  const hostConfig = join(hostRoot, '.config', 'opencode')
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-opencode-runtime-'))
  const hostProfile = resolveHostProfilePaths({ HOME: hostRoot })

  try {
    mkdirSync(hostConfig, { recursive: true })
    writeFileSync(join(hostConfig, 'auth.json'), '{"token":"test"}', 'utf8')

    const layout = opencodeRuntimeLayout(runtimeRoot)
    const materialized = materializeOpencodeAuth(runtimeRoot, hostProfile)
    const prepared = prepareProviderAuthForTest('opencode', runtimeRoot, {
      hostEnvironment: { HOME: hostRoot }
    })

    assert.equal(materialized.runtimeConfigDir, layout.configDir)
    assert.equal(materialized.runtimeDataDir, layout.dataDir)
    assert.equal(prepared.envPatch.XDG_CONFIG_HOME, layout.configHome)
    assert.equal(prepared.envPatch.XDG_DATA_HOME, layout.dataHome)
    assert.equal(prepared.envPatch.XDG_STATE_HOME, layout.stateHome)
    assert.ok(existsSync(join(layout.configDir, 'auth.json')))
    assert.equal(lstatSync(join(layout.configDir, 'auth.json')).isSymbolicLink(), true)
  } finally {
    rmSync(hostRoot, { recursive: true, force: true })
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})

test('OpenCode provider configuration alone is not reported as login material', () => {
  const hostRoot = mkdtempSync(join(tmpdir(), 'codetask-opencode-config-only-'))
  const hostConfig = join(hostRoot, '.config', 'opencode')
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-opencode-runtime-'))

  try {
    mkdirSync(hostConfig, { recursive: true })
    writeFileSync(join(hostConfig, 'opencode.json'), '{"model":"test/model"}', 'utf8')

    const prepared = prepareProviderAuthForTest('opencode', runtimeRoot, {
      hostEnvironment: { HOME: hostRoot }
    })
    assert.equal(prepared.diagnostics.authMaterialPresent, false)
    assert.ok(existsSync(join(opencodeRuntimeLayout(runtimeRoot).configDir, 'opencode.json')))
  } finally {
    rmSync(hostRoot, { recursive: true, force: true })
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})
