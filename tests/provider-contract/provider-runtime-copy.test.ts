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
  opencodeRuntimeLayout,
  projectOpencodeHostConfig
} from '../../src/server/sandbox/provider-auth/materialize'
import {
  credentialSnapshotManifestPath,
  scrubCredentialSnapshotsInTree
} from '../../src/server/sandbox/provider-auth/snapshot-manifest'
import {
  resolveClaudeHostConfigDir,
  resolveCursorHostConfigDir,
  resolveCursorHostCursorHome,
  resolveHostProfilePaths,
  runtimeCodexHome,
  runtimeCursorConfigDir,
  runtimeCursorHome
} from '../../src/server/sandbox/provider-auth/paths'

const RUNTIME_ISOLATED_PROVIDERS = ['codex', 'opencode'] as const

test('Codex and OpenCode use isolated runtime homes with no host write roots', () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-provider-bridge-'))
  const workspaceRoot = join(runtimeRoot, 'workspace')
  try {
    for (const provider of RUNTIME_ISOLATED_PROVIDERS) {
      const prepared = prepareProviderAuthForTest(provider, runtimeRoot, { workspaceRoot })
      assert.equal(prepared.diagnostics.mode, 'runtime-copy', provider)
      assert.equal(prepared.mode, 'runtime-copy', provider)
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

test('cursor sandbox keeps host Keychain identity while isolating all Cursor state writes', () => {
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
    assert.equal(prepared.envPatch.CURSOR_CONFIG_DIR, runtimeCursorConfigDir(runtimeRoot))
    assert.equal(prepared.envPatch.CURSOR_DATA_DIR, runtimeCursorHome(runtimeRoot))
    assert.equal(prepared.envPatch.XDG_CONFIG_HOME, join(runtimeRoot, 'config'))
    assert.equal(prepared.envPatch.XDG_CACHE_HOME, join(runtimeRoot, 'cache'))
    assert.equal(prepared.envPatch.XDG_DATA_HOME, join(runtimeRoot, 'data'))
    assert.equal(prepared.envPatch.XDG_STATE_HOME, join(runtimeRoot, 'state'))
    assert.deepEqual(prepared.filesystemProfile.hostReadRoots, prepared.readRoots)
    assert.deepEqual(prepared.filesystemProfile.hostWriteRoots, prepared.writeRoots)
    assert.equal((prepared.writeRoots ?? []).includes(runtimeCursorHome(runtimeRoot)), false)
    for (const root of prepared.writeRoots ?? []) {
      assert.equal(root.endsWith(`${join('cursor-agent', 'versions')}`), false)
      assert.equal(root.endsWith('.running'), true)
    }
    assert.equal((prepared.readRoots ?? []).includes(host.home), false)
    assert.equal(
      (prepared.readRoots ?? []).includes(resolveCursorHostCursorHome(host)),
      false
    )
    assert.equal(
      (prepared.readRoots ?? []).includes(resolveCursorHostConfigDir(host)),
      false
    )
    prepared.cleanupPlan()
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})

test('materializeCursorAuth references host identity files without copying them', () => {
  const hostRoot = mkdtempSync(join(tmpdir(), 'codetask-cursor-host-'))
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-cursor-runtime-'))
  const workspaceRoot = join(runtimeRoot, 'workspace')
  const profile = resolveHostProfilePaths({
    HOME: hostRoot,
    USERPROFILE: hostRoot,
    APPDATA: join(hostRoot, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(hostRoot, 'AppData', 'Local')
  })
  const hostCursorHome = resolveCursorHostCursorHome(profile)
  const hostConfigDir = resolveCursorHostConfigDir(profile)
  const hostCliConfig = join(hostConfigDir, 'cli-config.json')

  try {
    mkdirSync(workspaceRoot)
    mkdirSync(hostCursorHome, { recursive: true })
    mkdirSync(hostConfigDir, { recursive: true })
    writeFileSync(join(hostCursorHome, 'agent-cli-state.json'), '{"state":"host"}', 'utf8')
    writeFileSync(hostCliConfig, '{"auth":"keychain-reference"}', 'utf8')

    const result = materializeCursorAuth(runtimeRoot, workspaceRoot, profile)
    const runtimeCliConfig = join(runtimeCursorConfigDir(runtimeRoot), 'cli-config.json')

    assert.equal(result.authMaterialized, true)
    assert.ok(result.hostReferencePaths.includes(hostCliConfig))
    assert.equal(readFileSync(runtimeCliConfig, 'utf8'), '{"auth":"keychain-reference"}')
    assert.equal(
      lstatSync(runtimeCliConfig).isSymbolicLink(),
      process.platform !== 'win32'
    )

    result.cleanup()
    assert.equal(existsSync(runtimeCliConfig), false)
    assert.equal(readFileSync(hostCliConfig, 'utf8'), '{"auth":"keychain-reference"}')
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

test('materializeCodexAuth references host auth and generates a filtered config', () => {
  const hostRoot = mkdtempSync(join(tmpdir(), 'codetask-codex-host-'))
  const hostCodexHome = join(hostRoot, '.codex')
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-codex-runtime-'))
  const hostProfile = resolveHostProfilePaths({ HOME: hostRoot })

  try {
    mkdirSync(hostCodexHome)
    writeFileSync(join(hostCodexHome, 'auth.json'), '{"token":"host"}', 'utf8')
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
    assert.equal(result.authMaterialized, true)
    assert.equal(result.configGenerated, true)

    const runtimeConfig = join(runtimeCodexHome(runtimeRoot), 'config.toml')
    const runtimeAuth = join(runtimeCodexHome(runtimeRoot), 'auth.json')
    assert.ok(existsSync(runtimeConfig))
    assert.ok(existsSync(runtimeAuth))
    assert.equal(
      lstatSync(runtimeAuth).isSymbolicLink(),
      process.platform !== 'win32'
    )
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
    const sessionPath = join(runtimeRoot, '.codex', 'sessions', 'keep.json')
    mkdirSync(join(runtimeRoot, '.codex', 'sessions'), { recursive: true })
    writeFileSync(sessionPath, '{"session":true}', 'utf8')

    assert.equal(materialized.authMaterialized, true)
    assert.ok(existsSync(credentialSnapshotManifestPath(runtimeRoot)))

    const scrubbed = scrubCredentialSnapshotsInTree(runtimeTree)
    assert.equal(scrubbed.manifests, 1)
    assert.equal(scrubbed.files, 2)
    assert.equal(existsSync(join(runtimeRoot, '.codex', 'auth.json')), false)
    assert.equal(existsSync(join(runtimeRoot, '.codex', 'config.toml')), false)
    assert.equal(readFileSync(sessionPath, 'utf8'), '{"session":true}')
  } finally {
    rmSync(hostRoot, { recursive: true, force: true })
    rmSync(runtimeTree, { recursive: true, force: true })
  }
})

test('prepareClaude rejects environment-token auth and keeps host settings read-only', () => {
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
    assert.equal(prepared.diagnostics.authMaterialPresent, true)
    assert.match(prepared.diagnostics.warnings.join('\n'), /environment-token.*disabled/i)
    assert.notEqual(prepared.envPatch.PATH, '/should-not-inject')

    const hostConfigDir = resolveClaudeHostConfigDir(
      resolveHostProfilePaths({ HOME: hostRoot })
    ).toLowerCase()
    assert.ok((prepared.readRoots ?? []).some((root) => root.toLowerCase() === hostConfigDir))
    assert.deepEqual(prepared.writeRoots ?? [], [])
  } finally {
    rmSync(hostRoot, { recursive: true, force: true })
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})

test('prepareOpencode references credentials and drops unsafe host config sections', () => {
  const hostRoot = mkdtempSync(join(tmpdir(), 'codetask-opencode-host-config-'))
  const hostConfig = join(hostRoot, '.config', 'opencode')
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-opencode-runtime-'))
  const hostProfile = resolveHostProfilePaths({ HOME: hostRoot })

  try {
    mkdirSync(hostConfig, { recursive: true })
    writeFileSync(join(hostConfig, 'auth.json'), '{"token":"test"}', 'utf8')
    writeFileSync(join(hostConfig, 'opencode.json'), '{"mcp":{"host":{"type":"local"}}}', 'utf8')

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
    const runtimeAuth = join(layout.configDir, 'auth.json')
    assert.ok(existsSync(runtimeAuth))
    assert.equal(lstatSync(runtimeAuth).isSymbolicLink(), process.platform !== 'win32')
    const runtimeConfig = join(layout.configDir, 'opencode.json')
    assert.ok(existsSync(runtimeConfig))
    assert.equal(lstatSync(runtimeConfig).isSymbolicLink(), false)
    assert.deepEqual(JSON.parse(readFileSync(runtimeConfig, 'utf8')), {})
    assert.ok(prepared.readRoots.includes(join(hostConfig, 'auth.json')))
  } finally {
    rmSync(hostRoot, { recursive: true, force: true })
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})

test('OpenCode provider-only host config is safe to reference without copying', () => {
  const raw = JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: {
      example: {
        npm: '@ai-sdk/openai-compatible',
        options: { apiKey: 'host-only', baseURL: 'https://example.invalid/v1' },
        models: { current: { name: 'Current' } }
      }
    }
  })
  const projected = projectOpencodeHostConfig(raw)
  assert.ok(projected)
  assert.equal(projected.safeToReference, true)
  assert.deepEqual(JSON.parse(projected.projected), JSON.parse(raw))
})

test('OpenCode mixed host config projects only provider/model authority', () => {
  const projected = projectOpencodeHostConfig(
    JSON.stringify({
      provider: { example: { options: { apiKey: 'host-only' } } },
      model: 'example/current',
      mcp: { unsafe: { type: 'local', command: ['sh', '-c', 'exit 1'] } },
      plugin: ['unsafe-plugin'],
      instructions: ['host-prompt.md']
    })
  )
  assert.ok(projected)
  assert.equal(projected.safeToReference, false)
  assert.deepEqual(JSON.parse(projected.projected), {
    provider: { example: { options: { apiKey: 'host-only' } } },
    model: 'example/current'
  })
})
