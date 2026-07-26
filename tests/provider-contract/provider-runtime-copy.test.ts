import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareProviderAuthForTest } from '../helpers/provider-runtime'
import {
  materializeCodexAuth
} from '../../src/server/sandbox/provider-auth/materialize'
import {
  credentialSnapshotManifestPath,
  scrubCredentialSnapshotsInTree
} from '../../src/server/sandbox/provider-auth/snapshot-manifest'
import {
  resolveHostProfilePaths,
  runtimeCodexHome
} from '../../src/server/sandbox/provider-auth/paths'

const HOST_IDENTITY_PROVIDERS = ['codex', 'opencode'] as const

test('prepareProviderAuth defaults to host-identity with precise host path roots', () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-provider-bridge-'))
  const workspaceRoot = join(runtimeRoot, 'workspace')
  try {
    const host = resolveHostProfilePaths()
    for (const provider of HOST_IDENTITY_PROVIDERS) {
      const prepared = prepareProviderAuthForTest(provider, runtimeRoot, { workspaceRoot })
      assert.equal(prepared.diagnostics.mode, 'host-identity', provider)
      assert.equal(prepared.mode, 'host-identity', provider)
      assert.equal(prepared.runtimeRoot, runtimeRoot, provider)
      assert.equal('CODETASK_PROVIDER_AUTH_MODE' in prepared.envPatch, false, provider)
      assert.equal(prepared.envPatch.HOME, host.home, provider)
      assert.equal(prepared.envPatch.CODETASK_DATA_DIR, undefined, provider)
      assert.equal(prepared.filesystemProfile.provider, provider)
      assert.deepEqual(prepared.filesystemProfile.hostReadRoots, prepared.readRoots)
      assert.deepEqual(prepared.filesystemProfile.hostWriteRoots, prepared.writeRoots)
      assert.deepEqual(prepared.filesystemProfile.runtimeEnv, prepared.envPatch)
      assert.deepEqual(prepared.filesystemProfile.credentialSnapshots, [])
      assert.deepEqual(prepared.filesystemProfile.scrubPatterns, [])
      assert.ok((prepared.writeRoots ?? []).length > 0, provider)
      assert.ok(
        (prepared.readRoots ?? []).some((root) =>
          root.toLowerCase().startsWith(host.home.toLowerCase())
        ),
        `${provider} must allowlist a host path under HOME`
      )
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
    assert.ok((prepared.writeRoots ?? []).includes(join(runtimeRoot, '.cursor')))
    assert.ok((prepared.writeRoots ?? []).includes(join(host.home, '.cursor')))
    assert.ok((prepared.readRoots ?? []).includes(host.home))
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})

test('codex runtime env sets CODEX_HOME to host ~/.codex', () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-codex-env-'))
  try {
    const host = resolveHostProfilePaths()
    const prepared = prepareProviderAuthForTest('codex', runtimeRoot)
    assert.equal(prepared.envPatch.CODEX_HOME, join(host.home, '.codex'))
    assert.equal(prepared.envPatch.HOME, host.home)
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})

test('materializeCodexAuth copies filtered config.toml without MCP sections', () => {
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
    assert.equal(result.configCopied, true)

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

    assert.equal(materialized.authCopied, true)
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

test('prepareClaude uses host-identity env-inject and keeps session under runtime CLAUDE_CONFIG_DIR', () => {
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
    assert.equal(prepared.diagnostics.mode, 'host-identity')
    assert.equal(prepared.envPatch.CLAUDE_CONFIG_DIR, join(runtimeRoot, '.claude'))
    assert.equal(prepared.envPatch.HOME, hostRoot)
    assert.equal(prepared.envPatch.ANTHROPIC_API_KEY, 'sk-test')
    assert.notEqual(prepared.envPatch.PATH, '/should-not-inject')
    assert.ok((prepared.writeRoots ?? []).includes(join(runtimeRoot, '.claude')))
    assert.ok(
      (prepared.readRoots ?? []).some((root) =>
        root.toLowerCase().startsWith(hostClaude.toLowerCase())
      )
    )
  } finally {
    rmSync(hostRoot, { recursive: true, force: true })
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})

test('prepareOpencode uses host-identity XDG config/data and runtime state', () => {
  const hostRoot = mkdtempSync(join(tmpdir(), 'codetask-opencode-host-config-'))
  const hostConfig = join(hostRoot, '.config', 'opencode')
  const hostData = join(hostRoot, '.local', 'share', 'opencode')
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-opencode-runtime-'))

  try {
    mkdirSync(hostConfig, { recursive: true })
    writeFileSync(join(hostConfig, 'auth.json'), '{"token":"test"}', 'utf8')

    const prepared = prepareProviderAuthForTest('opencode', runtimeRoot, {
      hostEnvironment: { HOME: hostRoot }
    })

    assert.equal(prepared.mode, 'host-identity')
    assert.equal(prepared.diagnostics.mode, 'host-identity')
    assert.equal(prepared.diagnostics.authMaterialPresent, true)
    assert.equal(prepared.envPatch.HOME, hostRoot)
    assert.equal(prepared.envPatch.XDG_CONFIG_HOME, join(hostRoot, '.config'))
    assert.equal(prepared.envPatch.XDG_DATA_HOME, join(hostRoot, '.local', 'share'))
    assert.equal(prepared.envPatch.XDG_STATE_HOME, join(runtimeRoot, '.local', 'state'))
    assert.ok((prepared.readRoots ?? []).includes(hostConfig))
    assert.ok((prepared.readRoots ?? []).includes(hostData))
    assert.ok((prepared.writeRoots ?? []).includes(join(runtimeRoot, '.local', 'state')))
    // Production prepare must not materialize credential copies under runtime.
    assert.equal(existsSync(join(runtimeRoot, '.config', 'opencode', 'auth.json')), false)
  } finally {
    rmSync(hostRoot, { recursive: true, force: true })
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})
