import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SupportedCoreCode } from '../../src/shared/providers/codes.ts'
import type { ProviderInstallation } from '../../src/shared/providers/installation.ts'
import { runClaudeAuthPreflight } from '../../src/server/providers/claude/preflight.ts'
import { runCodexAuthPreflight } from '../../src/server/providers/codex/preflight.ts'
import {
  resolveExecutableEnvironmentAffinity,
  resolveProviderExecutableStrategy
} from '../../src/server/providers/runtime-executable.ts'
import { spawnProviderCommandSync } from '../../src/server/providers/spawn.ts'
import { prepareCodexRuntimeProfile } from '../../src/server/sandbox/provider-auth/bridge.ts'
import { ProviderAuthError } from '../../src/server/sandbox/provider-auth/errors.ts'
import {
  resolveClaudeInstallDirs,
  resolveCodexInstallDirs
} from '../../src/server/sandbox/provider-auth/paths.ts'
import type { ProviderRuntimeProfile } from '../../src/server/sandbox/provider-auth/types.ts'

function installation(
  provider: SupportedCoreCode,
  path: string,
  source: ProviderInstallation['source'] = 'path'
): ProviderInstallation {
  return {
    id: `${provider}:runtime-test`,
    provider,
    command: provider,
    source,
    invocation: { executable: path, prefixArgs: [] },
    resolvedPath: path,
    canonicalPath: path
  }
}

function runtimeProfile(
  provider: 'claude-code' | 'codex',
  authMaterialPresent: boolean
): ProviderRuntimeProfile {
  return {
    schemaVersion: 1,
    provider,
    platform: process.platform as ProviderRuntimeProfile['platform'],
    mode: 'host-identity',
    runtimeRoot: '/runtime',
    stateRoot: '/runtime',
    environment: { HOME: '/runtime' },
    hostPathGrants: [],
    diagnostics: {
      provider,
      mode: 'host-identity',
      authMaterialPresent,
      warnings: []
    }
  }
}

test('SDK-bundled providers override only an explicit app-config executable', () => {
  for (const provider of ['claude-code', 'codex'] as const) {
    assert.equal(resolveProviderExecutableStrategy(provider, 'path'), 'sdk-bundled')
    assert.equal(resolveProviderExecutableStrategy(provider, 'install-dir'), 'sdk-bundled')
    assert.equal(resolveProviderExecutableStrategy(provider, 'app-config'), 'installation')
  }
  for (const provider of ['cursorcli', 'opencode'] as const) {
    assert.equal(resolveProviderExecutableStrategy(provider, 'path'), 'installation')
    assert.equal(resolveProviderExecutableStrategy(provider, 'install-dir'), 'installation')
    assert.equal(resolveProviderExecutableStrategy(provider, 'app-config'), 'installation')
  }
})

test('SDK native package roots are discovered from installed optional dependencies', () => {
  const claudeExecutable = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const codexExecutable = process.platform === 'win32' ? 'codex.exe' : 'codex'
  const claudeDirs = resolveClaudeInstallDirs()
  const codexDirs = resolveCodexInstallDirs()

  assert.ok(claudeDirs.some((directory) => existsSync(join(directory, claudeExecutable))))
  assert.ok(codexDirs.some((directory) => existsSync(join(directory, codexExecutable))))
})

test('SDK native CLIs launch with an isolated profile and no toolchain-manager state', () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'cctask-sdk-native-launch-'))
  const executableNames = {
    'claude-code': process.platform === 'win32' ? 'claude.exe' : 'claude',
    codex: process.platform === 'win32' ? 'codex.exe' : 'codex'
  } as const
  const installDirs = {
    'claude-code': resolveClaudeInstallDirs(),
    codex: resolveCodexInstallDirs()
  } as const
  const env: Record<string, string> = {
    HOME: runtimeRoot,
    USERPROFILE: runtimeRoot,
    PATH: process.env.PATH ?? ''
  }
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'PATHEXT'] as const) {
    const value = process.env[key]
    if (value) env[key] = value
  }

  try {
    for (const provider of ['claude-code', 'codex'] as const) {
      const executable = installDirs[provider]
        .map((directory) => join(directory, executableNames[provider]))
        .find((candidate) => existsSync(candidate))
      assert.ok(executable, `${provider} SDK native executable is missing`)
      const result = spawnProviderCommandSync({ executable, prefixArgs: [] }, ['--version'], {
        cwd: runtimeRoot,
        env,
        timeout: 15_000
      })
      assert.equal(
        result.status,
        0,
        `${provider} native launch failed: ${(result.stderr ?? '').trim()}`
      )
      assert.match(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, /\d+\.\d+/)
    }
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})

test('external CLI affinity is derived from executable paths on Linux, macOS, and Windows', () => {
  const cases = [
    {
      platform: 'linux' as const,
      executable: '/home/user/.next-tool/bin/opencode',
      root: '/home/user/.next-tool'
    },
    {
      platform: 'darwin' as const,
      executable: '/Users/user/Library/NextTool/shims/opencode',
      root: '/Users/user/Library/NextTool'
    },
    {
      platform: 'win32' as const,
      executable: 'C:\\Users\\user\\AppData\\Local\\NextTool\\bin\\opencode.exe',
      root: 'C:\\Users\\user\\AppData\\Local\\NextTool'
    }
  ]

  for (const entry of cases) {
    const affinity = resolveExecutableEnvironmentAffinity(
      installation('opencode', entry.executable),
      {
        NEXT_TOOL_ROOT: entry.root,
        HOME: entry.platform === 'win32' ? 'C:\\Users\\user' : '/home/user',
        NEXT_TOOL_TOKEN: entry.root,
        NODE_PATH: entry.root,
        UNRELATED_VALUE: entry.root,
        UNRELATED_ROOT: entry.platform === 'win32' ? 'D:\\unrelated\\tool' : '/opt/unrelated/tool'
      },
      entry.platform
    )
    assert.deepEqual(affinity.environment, { NEXT_TOOL_ROOT: entry.root })
    assert.deepEqual(affinity.readRoots, [entry.root])
  }
})

test('SDK-bundled automatic providers do not inherit external executable affinity', () => {
  const path = '/home/user/.next-tool/bin/claude'
  const affinity = resolveExecutableEnvironmentAffinity(
    installation('claude-code', path),
    { NEXT_TOOL_ROOT: '/home/user/.next-tool' },
    'linux'
  )
  assert.deepEqual(affinity.environment, {})
  assert.deepEqual(affinity.readRoots, [])
})

test('Claude and Codex preflight trust the compiled runtime profile, not a host shim', () => {
  const failingHostShim = process.execPath
  const claudeInstallation = {
    ...installation('claude-code', failingHostShim),
    invocation: { executable: failingHostShim, prefixArgs: ['-e', 'process.exit(91)'] }
  }
  const codexInstallation = {
    ...installation('codex', failingHostShim),
    invocation: { executable: failingHostShim, prefixArgs: ['-e', 'process.exit(92)'] }
  }

  assert.doesNotThrow(() =>
    runClaudeAuthPreflight(runtimeProfile('claude-code', true), claudeInstallation)
  )
  assert.doesNotThrow(() => runCodexAuthPreflight(runtimeProfile('codex', true), codexInstallation))

  assert.throws(
    () => runClaudeAuthPreflight(runtimeProfile('claude-code', false), claudeInstallation),
    (error) =>
      error instanceof ProviderAuthError && error.code === 'provider.claude.not_authenticated'
  )
  assert.throws(
    () => runCodexAuthPreflight(runtimeProfile('codex', false), codexInstallation),
    (error) =>
      error instanceof ProviderAuthError && error.code === 'provider.codex.not_authenticated'
  )
})

test('Codex config alone is not misclassified as authentication material', () => {
  const home = mkdtempSync(join(tmpdir(), 'cctask-codex-config-only-'))
  const runtimeRoot = join(home, 'runtime')
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "test-model"\n')

  try {
    const profile = prepareCodexRuntimeProfile({
      runtimeRoot,
      hostEnvironment: Object.freeze({ HOME: home, PATH: process.env.PATH ?? '' })
    })
    assert.equal(profile.diagnostics.authMaterialPresent, false)
    assert.match(profile.diagnostics.warnings.join('\n'), /Host Codex login file not found/i)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
