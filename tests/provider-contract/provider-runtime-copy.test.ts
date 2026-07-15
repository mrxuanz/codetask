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

test('cursor sandbox uses host-identity with host profile read/write roots', () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-cursor-bridge-'))
  const workspaceRoot = join(runtimeRoot, 'workspace')
  try {
    const host = resolveHostProfilePaths()
    const prepared = prepareProviderAuth('cursorcli', runtimeRoot, { workspaceRoot })

    assert.equal(prepared.diagnostics.mode, 'host-identity')
    assert.equal(prepared.envPatch.CODETASK_PROVIDER_AUTH_MODE, 'host-identity')
    assert.equal(prepared.envPatch.HOME, host.home)
    assert.equal(prepared.envPatch.CODETASK_RUNTIME_ROOT, runtimeRoot)
    assert.ok((prepared.writeRoots ?? []).length > 0)
    assert.ok(
      (prepared.writeRoots ?? []).some((root) =>
        root.toLowerCase().includes(join(host.home, '.cursor').toLowerCase())
      )
    )
    assert.ok(
      (prepared.readRoots ?? []).some((root) => root.toLowerCase() === host.home.toLowerCase())
    )
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
