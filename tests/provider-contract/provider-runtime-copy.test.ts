import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareProviderAuth } from '../../src/server/sandbox/provider-auth/bridge'
import {
  materializeCodexAuth,
  materializeOpencodeAuth,
  opencodeRuntimeLayout
} from '../../src/server/sandbox/provider-auth/materialize'
import {
  credentialSnapshotManifestPath,
  scrubCredentialSnapshotsInTree
} from '../../src/server/sandbox/provider-auth/snapshot-manifest'
import {
  resolveClaudeHostConfigDir,
  resolveHostProfilePaths,
  runtimeCodexHome
} from '../../src/server/sandbox/provider-auth/paths'

const RUNTIME_COPY_PROVIDERS = ['codex', 'claude-code', 'opencode'] as const

test('prepareProviderAuth defaults to runtime-copy with no host write roots', () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-provider-bridge-'))
  const workspaceRoot = join(runtimeRoot, 'workspace')
  try {
    for (const provider of RUNTIME_COPY_PROVIDERS) {
      const prepared = prepareProviderAuth(provider, runtimeRoot, { workspaceRoot })
      assert.equal(prepared.diagnostics.mode, 'runtime-copy', provider)
      assert.deepEqual(prepared.writeRoots ?? [], [], provider)
      assert.equal(prepared.envPatch.CODETASK_PROVIDER_AUTH_MODE, 'runtime-copy', provider)
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
    const prepared = prepareProviderAuth('cursorcli', runtimeRoot, { workspaceRoot })

    assert.equal(prepared.diagnostics.mode, 'host-identity')
    assert.equal(prepared.envPatch.CODETASK_PROVIDER_AUTH_MODE, 'host-identity')
    assert.equal(prepared.envPatch.HOME, host.home)
    assert.equal(prepared.envPatch.CODETASK_RUNTIME_ROOT, runtimeRoot)
    assert.equal(prepared.envPatch.CURSOR_DATA_DIR, join(runtimeRoot, '.cursor'))
    assert.deepEqual(prepared.filesystemProfile.hostReadRoots, prepared.readRoots)
    assert.deepEqual(prepared.filesystemProfile.hostWriteRoots, prepared.writeRoots)
    assert.ok((prepared.writeRoots ?? []).includes(join(runtimeRoot, '.cursor')))
    assert.ok((prepared.writeRoots ?? []).includes(join(host.home, '.cursor')))
    assert.ok((prepared.readRoots ?? []).includes(host.home))
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})

test('codex runtime env sets CODEX_HOME under runtimeRoot', () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-codex-env-'))
  try {
    const prepared = prepareProviderAuth('codex', runtimeRoot)
    assert.equal(prepared.envPatch.CODEX_HOME, runtimeCodexHome(runtimeRoot))
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})

test('materializeCodexAuth copies filtered config.toml without MCP sections', () => {
  const hostCodexHome = mkdtempSync(join(tmpdir(), 'codetask-codex-host-'))
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-codex-runtime-'))
  const prevHome = process.env.CODETASK_CODEX_HOME
  process.env.CODETASK_CODEX_HOME = hostCodexHome

  try {
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

    const result = materializeCodexAuth(runtimeRoot)
    assert.equal(result.configCopied, true)

    const runtimeConfig = join(runtimeCodexHome(runtimeRoot), 'config.toml')
    assert.ok(existsSync(runtimeConfig))
    const raw = readFileSync(runtimeConfig, 'utf8')
    assert.match(raw, /model = "gpt-test"/)
    assert.doesNotMatch(raw, /mcp_servers/)
    assert.doesNotMatch(raw, /\[plugins\]/)
  } finally {
    if (prevHome === undefined) delete process.env.CODETASK_CODEX_HOME
    else process.env.CODETASK_CODEX_HOME = prevHome
    rmSync(hostCodexHome, { recursive: true, force: true })
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})

test('materializeCodexAuth preserves existing session rollouts across turns', () => {
  const hostCodexHome = mkdtempSync(join(tmpdir(), 'codetask-codex-host-'))
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-codex-runtime-'))
  const prevHome = process.env.CODETASK_CODEX_HOME
  process.env.CODETASK_CODEX_HOME = hostCodexHome

  try {
    writeFileSync(join(hostCodexHome, 'auth.json'), '{"token":"host"}', 'utf8')
    writeFileSync(join(hostCodexHome, 'config.toml'), 'model = "gpt-test"\n', 'utf8')

    materializeCodexAuth(runtimeRoot)

    const codexHome = runtimeCodexHome(runtimeRoot)
    const rolloutDir = join(codexHome, 'sessions', '019f6434-ebb9-7e10-b5e8-c97e50d202ee')
    const rolloutPath = join(rolloutDir, 'rollout.json')
    mkdirSync(rolloutDir, { recursive: true })
    writeFileSync(rolloutPath, '{"thread":"preserved"}', 'utf8')

    materializeCodexAuth(runtimeRoot)

    assert.equal(readFileSync(rolloutPath, 'utf8'), '{"thread":"preserved"}')
    assert.equal(readFileSync(join(codexHome, 'auth.json'), 'utf8'), '{"token":"host"}')
    assert.match(readFileSync(join(codexHome, 'config.toml'), 'utf8'), /model = "gpt-test"/)
  } finally {
    if (prevHome === undefined) delete process.env.CODETASK_CODEX_HOME
    else process.env.CODETASK_CODEX_HOME = prevHome
    rmSync(hostCodexHome, { recursive: true, force: true })
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})

test('credential snapshots are manifested and startup scrub removes only recorded runtime files', () => {
  const hostCodexHome = mkdtempSync(join(tmpdir(), 'codetask-codex-host-'))
  const runtimeTree = mkdtempSync(join(tmpdir(), 'codetask-runtime-tree-'))
  const runtimeRoot = join(runtimeTree, 'thread-1', 'jobs', 'job-1', 'codex')
  const prevHome = process.env.CODETASK_CODEX_HOME
  process.env.CODETASK_CODEX_HOME = hostCodexHome

  try {
    mkdirSync(runtimeRoot, { recursive: true })
    writeFileSync(join(hostCodexHome, 'auth.json'), '{"token":"host"}', 'utf8')
    writeFileSync(join(hostCodexHome, 'config.toml'), 'model = "gpt-test"\n', 'utf8')

    const materialized = materializeCodexAuth(runtimeRoot)
    const sessionPath = join(runtimeRoot, '.codex', 'sessions', 'keep.json')
    mkdirSync(join(runtimeRoot, '.codex', 'sessions'), { recursive: true })
    writeFileSync(sessionPath, '{"session":true}', 'utf8')

    assert.equal(materialized.authCopied, true)
    assert.ok(existsSync(credentialSnapshotManifestPath(runtimeRoot)))

    const scrubbed = scrubCredentialSnapshotsInTree(runtimeTree)
    assert.equal(scrubbed.manifests, 1)
    assert.equal(scrubbed.files, 2)
    assert.equal(existsSync(join(runtimeRoot, '.codex', 'auth.json')), false)
    assert.equal(existsSync(join(runtimeRoot, '.codex', 'config.toml')), false)
    assert.equal(readFileSync(sessionPath, 'utf8'), '{"session":true}')
  } finally {
    if (prevHome === undefined) delete process.env.CODETASK_CODEX_HOME
    else process.env.CODETASK_CODEX_HOME = prevHome
    rmSync(hostCodexHome, { recursive: true, force: true })
    rmSync(runtimeTree, { recursive: true, force: true })
  }
})

test('prepareClaude isolates CLAUDE_CONFIG_DIR and does not expose host ~/.claude read roots', () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-claude-env-'))
  const hostClaude = mkdtempSync(join(tmpdir(), 'codetask-claude-host-'))
  const prevConfig = process.env.CODETASK_CLAUDE_CONFIG_DIR
  process.env.CODETASK_CLAUDE_CONFIG_DIR = hostClaude

  try {
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

    const prepared = prepareProviderAuth('claude-code', runtimeRoot)
    assert.equal(prepared.envPatch.CLAUDE_CONFIG_DIR, join(runtimeRoot, '.claude'))
    assert.equal(prepared.envPatch.HOME, runtimeRoot)
    assert.equal(prepared.envPatch.ANTHROPIC_API_KEY, 'sk-test')
    assert.equal(prepared.envPatch.PATH, undefined)

    const hostConfigDir = resolveClaudeHostConfigDir().toLowerCase()
    for (const readRoot of prepared.readRoots ?? []) {
      assert.ok(
        !readRoot.toLowerCase().startsWith(hostConfigDir),
        `must not read host claude config: ${readRoot}`
      )
    }
  } finally {
    if (prevConfig === undefined) delete process.env.CODETASK_CLAUDE_CONFIG_DIR
    else process.env.CODETASK_CLAUDE_CONFIG_DIR = prevConfig
    rmSync(hostClaude, { recursive: true, force: true })
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})

test('prepareOpencode aligns XDG env with materializeOpencodeAuth destinations', () => {
  const hostConfig = mkdtempSync(join(tmpdir(), 'codetask-opencode-host-config-'))
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-opencode-runtime-'))
  const prevConfig = process.env.CODETASK_OPENCODE_CONFIG_DIR
  process.env.CODETASK_OPENCODE_CONFIG_DIR = hostConfig

  try {
    writeFileSync(join(hostConfig, 'auth.json'), '{"token":"test"}', 'utf8')

    const layout = opencodeRuntimeLayout(runtimeRoot)
    const materialized = materializeOpencodeAuth(runtimeRoot)
    const prepared = prepareProviderAuth('opencode', runtimeRoot)

    assert.equal(materialized.runtimeConfigDir, layout.configDir)
    assert.equal(materialized.runtimeDataDir, layout.dataDir)
    assert.equal(prepared.envPatch.XDG_CONFIG_HOME, layout.configHome)
    assert.equal(prepared.envPatch.XDG_DATA_HOME, layout.dataHome)
    assert.equal(prepared.envPatch.XDG_STATE_HOME, layout.stateHome)
    assert.ok(existsSync(join(layout.configDir, 'auth.json')))
  } finally {
    if (prevConfig === undefined) delete process.env.CODETASK_OPENCODE_CONFIG_DIR
    else process.env.CODETASK_OPENCODE_CONFIG_DIR = prevConfig
    rmSync(hostConfig, { recursive: true, force: true })
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})
