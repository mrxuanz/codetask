import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { SupportedCoreCode } from '../../conversation/cores'
import { applyWindowsCrashReporterEnv } from '../../agent-runtime/env'
import {
  resolveClaudeInstallDirs,
  resolveCodexHostAuthPath,
  resolveCodexInstallDirs,
  resolveCursorAgentInstallDirs,
  resolveHostProfilePaths,
  resolveOpencodeExecutable,
  resolveOpencodeInstallDirs,
  runtimeCodexHome,
  snapshotClaudeHostSettings,
  snapshotCodexHostAuth,
  snapshotCursorHostAuth,
  snapshotOpencodeHostAuth
} from './paths'
import {
  materializeCodexAuth,
  materializeCursorAuth,
  materializeOpencodeAuth,
  opencodeRuntimeLayout
} from './materialize'
import type { ProviderAuthDiagnostics, ProviderAuthMode, ProviderAuthPrepared } from './types'

const RUNTIME_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CURSOR_API_KEY',
  'CURSOR_AUTH_TOKEN',
  'OPENCODE_API_KEY'
] as const

function uniqueRoots(roots: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const root of roots) {
    const key = root.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(root)
  }
  return out
}

function copyRuntimeAuthEnv(env: Record<string, string>): void {
  for (const key of RUNTIME_AUTH_ENV_KEYS) {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim()) {
      env[key] = value.trim()
    }
  }
}

function buildRuntimeBaseEnv(runtimeRoot: string): Record<string, string> {
  const tmp = join(runtimeRoot, 'tmp')
  mkdirSync(tmp, { recursive: true })

  const env: Record<string, string> = {
    HOME: runtimeRoot,
    CODETASK_RUNTIME_ROOT: runtimeRoot,
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    CODETASK_PROVIDER_AUTH_MODE: 'runtime-copy' satisfies ProviderAuthMode
  }

  if (process.platform === 'win32') {
    env.USERPROFILE = runtimeRoot
    env.APPDATA = join(runtimeRoot, 'AppData', 'Roaming')
    env.LOCALAPPDATA = join(runtimeRoot, 'AppData', 'Local')
    if (/^[A-Za-z]:/.test(runtimeRoot)) {
      env.HOMEDRIVE = runtimeRoot.slice(0, 2)
      env.HOMEPATH = runtimeRoot.slice(2) || '\\'
    }
    applyWindowsCrashReporterEnv(env)
  } else {
    env.XDG_CONFIG_HOME = join(runtimeRoot, 'config')
    env.XDG_CACHE_HOME = join(runtimeRoot, 'cache')
    env.XDG_DATA_HOME = join(runtimeRoot, 'data')
    env.XDG_STATE_HOME = join(runtimeRoot, 'state')
  }

  copyRuntimeAuthEnv(env)
  return env
}

function prepareCodex(runtimeRoot: string): ProviderAuthPrepared {
  const hostAuth = snapshotCodexHostAuth()
  const hostAuthPath = resolveCodexHostAuthPath()
  const materialized = materializeCodexAuth(runtimeRoot)
  const codexHome = runtimeCodexHome(runtimeRoot)

  const envPatch = {
    ...buildRuntimeBaseEnv(runtimeRoot),
    CODEX_HOME: codexHome
  }

  const diagnostics: ProviderAuthDiagnostics = {
    provider: 'codex',
    mode: 'runtime-copy',
    authMaterialPresent: materialized.authCopied || materialized.configCopied || hostAuth.present,
    hostAuthPath,
    runtimeAuthPath: materialized.runtimeAuthPath,
    warnings:
      materialized.authCopied || materialized.configCopied
        ? [
            'Codex auth/config snapshotted to runtime (config.toml filtered for MCP/sandbox); inner danger-full-access + approval_policy=never.'
          ]
        : [`Host Codex auth file not found: ${hostAuthPath} (set OPENAI_API_KEY / CODEX_API_KEY)`]
  }

  const readRoots = uniqueRoots([...resolveCodexInstallDirs()])
  return {
    envPatch,
    readRoots,
    writeRoots: [],
    cleanupPlan: () => materialized.cleanup(),
    diagnostics,
    filesystemProfile: {
      provider: 'codex',
      hostReadRoots: readRoots,
      hostWriteRoots: [],
      runtimeEnv: envPatch,
      credentialSnapshots: [
        { relativePath: '.codex/auth.json', required: false },
        { relativePath: '.codex/config.toml', required: false }
      ],
      scrubPatterns: ['.codex/auth.json', '.codex/config.toml']
    }
  }
}

const preparedCursorRuntimeRoots = new Set<string>()

function prepareCursor(runtimeRoot: string, workspaceRoot: string): ProviderAuthPrepared {
  const profile = resolveHostProfilePaths()
  const hostAuth = snapshotCursorHostAuth(profile)
  const hasPreparedRuntime =
    preparedCursorRuntimeRoots.has(runtimeRoot) &&
    existsSync(join(runtimeRoot, '.cursor')) &&
    existsSync(join(runtimeRoot, 'config', 'cursor'))
  const materialized = hasPreparedRuntime ? null : materializeCursorAuth(runtimeRoot, workspaceRoot)
  preparedCursorRuntimeRoots.add(runtimeRoot)
  const envPatch = {
    ...buildRuntimeBaseEnv(runtimeRoot),
    CODETASK_PROVIDER_AUTH_MODE: 'runtime-copy' satisfies ProviderAuthMode,
    CURSOR_DATA_DIR: join(runtimeRoot, '.cursor')
  }

  const diagnostics: ProviderAuthDiagnostics = {
    provider: 'cursorcli',
    mode: 'runtime-copy',
    authMaterialPresent: hostAuth.present || hostAuth.sources.length > 0,
    hostAuthPath: hostAuth.authPath,
    runtimeAuthPath:
      materialized?.runtimeAuthPath ?? join(runtimeRoot, 'config', 'cursor', 'auth.json'),
    warnings: [
      hostAuth.present || hostAuth.sources.length > 0
        ? 'Cursor auth/config is copied into the scope runtime; host Cursor directories are read-only.'
        : `Host Cursor auth.json not found (macOS may use Keychain login only); set CURSOR_API_KEY.`,
      'ACP uses --force --sandbox disabled --approve-mcps --trust; temp files written to runtime.'
    ]
  }

  const readRoots = uniqueRoots([...hostAuth.sources, ...resolveCursorAgentInstallDirs()])
  const writeRoots = [join(runtimeRoot, '.cursor')]
  return {
    envPatch,
    readRoots,
    writeRoots,
    // Cursor ACP is intentionally long-lived. Runtime credentials are scrubbed with the runtime
    // tree on scope close/startup janitor, not after each prompt.
    cleanupPlan: () => undefined,
    diagnostics: {
      ...diagnostics,
      warnings: [
        ...diagnostics.warnings,
        'P5: workspace .cursor is not writable; Cursor project metadata uses runtimeRoot CURSOR_DATA_DIR.'
      ]
    },
    filesystemProfile: {
      provider: 'cursorcli',
      hostReadRoots: readRoots,
      hostWriteRoots: writeRoots,
      runtimeEnv: envPatch,
      credentialSnapshots: [{ relativePath: 'config/cursor/auth.json', required: false }],
      scrubPatterns: ['config/cursor/auth.json']
    }
  }
}

function prepareClaude(runtimeRoot: string): ProviderAuthPrepared {
  const hostSettings = snapshotClaudeHostSettings()
  const claudeDir = join(runtimeRoot, '.claude')
  mkdirSync(claudeDir, { recursive: true })

  const envPatch = {
    ...buildRuntimeBaseEnv(runtimeRoot),
    CLAUDE_CONFIG_DIR: claudeDir,
    ...hostSettings.env
  }

  const hasAuthEnv = Object.keys(envPatch).some(
    (key) =>
      key === 'ANTHROPIC_API_KEY' ||
      key === 'ANTHROPIC_AUTH_TOKEN' ||
      key === 'CLAUDE_CODE_OAUTH_TOKEN'
  )

  const diagnostics: ProviderAuthDiagnostics = {
    provider: 'claude-code',
    mode: 'runtime-copy',
    authMaterialPresent: hasAuthEnv,
    hostAuthPath: hostSettings.settingsPath,
    runtimeAuthPath: claudeDir,
    warnings: [
      hasAuthEnv
        ? `Claude host settings injected as auth env only; session state written to ${claudeDir}.`
        : `No injectable Claude auth env found (${hostSettings.settingsPath}); ANTHROPIC_* / CLAUDE_CODE_OAUTH_TOKEN required.`,
      'Claude inner bypassPermissions + sandbox disabled; settingSources=[]; outer sandbox is the only boundary.'
    ]
  }

  const readRoots = uniqueRoots([...resolveClaudeInstallDirs()])
  return {
    envPatch,
    readRoots,
    writeRoots: [],
    cleanupPlan: () => undefined,
    diagnostics,
    filesystemProfile: {
      provider: 'claude-code',
      hostReadRoots: readRoots,
      hostWriteRoots: [],
      runtimeEnv: envPatch,
      credentialSnapshots: [],
      scrubPatterns: []
    }
  }
}

function prepareOpencode(runtimeRoot: string): ProviderAuthPrepared {
  const hostAuth = snapshotOpencodeHostAuth()
  const materialized = materializeOpencodeAuth(runtimeRoot)
  const layout = opencodeRuntimeLayout(runtimeRoot)

  const envPatch = {
    ...buildRuntimeBaseEnv(runtimeRoot),
    XDG_CONFIG_HOME: layout.configHome,
    XDG_DATA_HOME: layout.dataHome,
    XDG_STATE_HOME: layout.stateHome,
    CODETASK_OPENCODE_BIN: resolveOpencodeExecutable()
  }

  const diagnostics: ProviderAuthDiagnostics = {
    provider: 'opencode',
    mode: 'runtime-copy',
    authMaterialPresent: materialized.configCopied || hostAuth.present,
    hostAuthPath: materialized.hostConfigDir,
    runtimeAuthPath: materialized.runtimeConfigDir,
    warnings: materialized.configCopied
      ? [
          'OpenCode config/auth snapshotted to runtime XDG directories; question denied + auto-replied if asked; MCP injected via OPENCODE_CONFIG_CONTENT.'
        ]
      : ['OpenCode config directory is empty (will rely on environment variable API key)']
  }

  const readRoots = uniqueRoots([...resolveOpencodeInstallDirs()])
  return {
    envPatch,
    readRoots,
    writeRoots: [],
    cleanupPlan: () => materialized.cleanup(),
    diagnostics,
    filesystemProfile: {
      provider: 'opencode',
      hostReadRoots: readRoots,
      hostWriteRoots: [],
      runtimeEnv: envPatch,
      credentialSnapshots: [
        { relativePath: '.config/opencode/auth.json', required: false },
        { relativePath: '.local/share/opencode/auth.json', required: false }
      ],
      scrubPatterns: [
        '.config/opencode/auth.json',
        '.config/opencode/credentials.json',
        '.local/share/opencode/auth.json',
        '.local/share/opencode/credentials.json'
      ]
    }
  }
}

export interface PrepareProviderAuthOptions {
  workspaceRoot?: string
}

export function prepareProviderAuth(
  provider: SupportedCoreCode,
  runtimeRoot: string,
  _options?: PrepareProviderAuthOptions
): ProviderAuthPrepared {
  switch (provider) {
    case 'codex':
      return prepareCodex(runtimeRoot)
    case 'cursorcli':
      return prepareCursor(runtimeRoot, _options?.workspaceRoot ?? runtimeRoot)
    case 'claude-code':
      return prepareClaude(runtimeRoot)
    case 'opencode':
      return prepareOpencode(runtimeRoot)
    default:
      throw new Error(`Unsupported provider for auth bridge: ${provider}`)
  }
}
