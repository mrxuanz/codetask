import { mkdirSync } from 'fs'
import { join } from 'path'
import { applyWindowsCrashReporterEnv } from '../../agent-runtime/env'
import {
  resolveClaudeInstallDirs,
  resolveCodexHostAuthPath,
  resolveCodexInstallDirs,
  resolveCursorAgentInstallDirs,
  resolveCursorHostCursorHome,
  resolveHostProfilePaths,
  resolveOpencodeInstallDirs,
  runtimeCodexHome,
  snapshotClaudeHostSettings,
  snapshotCodexHostAuth,
  snapshotCursorHostAuth,
  snapshotOpencodeHostAuth
} from './paths'
import { materializeCodexAuth, materializeOpencodeAuth, opencodeRuntimeLayout } from './materialize'
import type { ProviderAuthDiagnostics, ProviderAuthPrepared } from './types'
import {
  processHostEnvironmentSource,
  type HostEnvironmentSnapshot
} from '../../host-environment'

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

const HOST_EXECUTION_ENV_KEYS = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'COMSPEC',
  'ComSpec',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy'
] as const

function copySelectedHostEnv(
  env: Record<string, string>,
  hostEnvironment: HostEnvironmentSnapshot,
  keys: readonly string[]
): void {
  for (const key of keys) {
    const value = hostEnvironment[key]
    if (typeof value === 'string' && value.trim()) {
      env[key] = value
    }
  }
}

function copyRuntimeAuthEnv(
  env: Record<string, string>,
  hostEnvironment: HostEnvironmentSnapshot
): void {
  for (const key of RUNTIME_AUTH_ENV_KEYS) {
    const value = hostEnvironment[key]
    if (typeof value === 'string' && value.trim()) {
      env[key] = value.trim()
    }
  }
}

function buildRuntimeBaseEnv(
  runtimeRoot: string,
  hostEnvironment: HostEnvironmentSnapshot
): Record<string, string> {
  const tmp = join(runtimeRoot, 'tmp')
  mkdirSync(tmp, { recursive: true })

  const env: Record<string, string> = {
    HOME: runtimeRoot,
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp
  }
  copySelectedHostEnv(env, hostEnvironment, HOST_EXECUTION_ENV_KEYS)

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

  copyRuntimeAuthEnv(env, hostEnvironment)
  return env
}

function buildHostIdentityEnv(
  runtimeRoot: string,
  profile = resolveHostProfilePaths(),
  hostEnvironment: HostEnvironmentSnapshot = processHostEnvironmentSource.snapshot()
): Record<string, string> {
  const tmp = join(runtimeRoot, 'tmp')
  mkdirSync(tmp, { recursive: true })

  const env: Record<string, string> = {
    HOME: profile.home,
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp
  }
  copySelectedHostEnv(env, hostEnvironment, HOST_EXECUTION_ENV_KEYS)

  if (process.platform === 'win32') {
    env.USERPROFILE = profile.home
    env.APPDATA = profile.appData
    env.LOCALAPPDATA = profile.localAppData
    if (/^[A-Za-z]:/.test(profile.home)) {
      env.HOMEDRIVE = profile.home.slice(0, 2)
      env.HOMEPATH = profile.home.slice(2) || '\\'
    }
    applyWindowsCrashReporterEnv(env)
  } else {
    env.XDG_CONFIG_HOME = join(profile.home, '.config')
    env.XDG_CACHE_HOME = join(profile.home, '.cache')
    env.XDG_DATA_HOME = join(profile.home, '.local', 'share')
  }

  copyRuntimeAuthEnv(env, hostEnvironment)
  return env
}

export interface ProviderAuthPreparationOptions {
  readonly runtimeRoot: string
  readonly workspaceRoot?: string | undefined
  readonly hostEnvironment?: HostEnvironmentSnapshot | undefined
}

function authPreparationContext(input: ProviderAuthPreparationOptions): {
  runtimeRoot: string
  workspaceRoot: string
  hostEnvironment: HostEnvironmentSnapshot
} {
  return {
    runtimeRoot: input.runtimeRoot,
    workspaceRoot: input.workspaceRoot ?? input.runtimeRoot,
    hostEnvironment: input.hostEnvironment ?? processHostEnvironmentSource.snapshot()
  }
}

export function prepareCodexAuth(input: ProviderAuthPreparationOptions): ProviderAuthPrepared {
  const { runtimeRoot, hostEnvironment } = authPreparationContext(input)
  const profile = resolveHostProfilePaths(hostEnvironment)
  const hostAuth = snapshotCodexHostAuth(profile, hostEnvironment)
  const hostAuthPath = resolveCodexHostAuthPath(profile)
  const materialized = materializeCodexAuth(runtimeRoot, profile)
  const codexHome = runtimeCodexHome(runtimeRoot)

  const envPatch = {
    ...buildRuntimeBaseEnv(runtimeRoot, hostEnvironment),
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
    mode: 'runtime-copy',
    runtimeRoot,
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

export function prepareCursorAuth(input: ProviderAuthPreparationOptions): ProviderAuthPrepared {
  const { runtimeRoot, hostEnvironment } = authPreparationContext(input)
  const profile = resolveHostProfilePaths(hostEnvironment)
  const hostAuth = snapshotCursorHostAuth(profile, hostEnvironment)
  const cursorHome = resolveCursorHostCursorHome(profile)
  // Keep project metadata under runtime (P5), but use host identity so macOS Keychain /
  // seatbelt ACP can authenticate. runtime-copy HOME breaks Keychain and still fails ACP
  // under outer sandbox even with file-store auth.

  const envPatch = {
    ...buildHostIdentityEnv(runtimeRoot, profile, hostEnvironment),
    CURSOR_DATA_DIR: join(runtimeRoot, '.cursor')
  }

  const diagnostics: ProviderAuthDiagnostics = {
    provider: 'cursorcli',
    mode: 'host-identity',
    authMaterialPresent: hostAuth.present || hostAuth.sources.length > 0,
    hostAuthPath: hostAuth.authPath,
    runtimeAuthPath: hostAuth.authPath,
    warnings: [
      hostAuth.present || hostAuth.sources.length > 0
        ? 'Cursor uses the host profile identity (including macOS Keychain); outer sandbox allows read/write to ~/.cursor and related directories.'
        : `Host Cursor auth.json not found (macOS may use Keychain login only); set CURSOR_API_KEY.`,
      'ACP uses --force --sandbox disabled --approve-mcps --trust; temp files written to runtime.'
    ]
  }

  const readRoots = uniqueRoots([
    profile.home,
    cursorHome,
    hostAuth.configDir,
    profile.appData,
    profile.localAppData,
    ...resolveCursorAgentInstallDirs()
  ])
  const writeRoots = uniqueRoots([cursorHome, hostAuth.configDir, join(runtimeRoot, '.cursor')])
  return {
    mode: 'host-identity',
    runtimeRoot,
    envPatch,
    readRoots,
    writeRoots,
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
      credentialSnapshots: [],
      scrubPatterns: []
    }
  }
}

export function prepareClaudeAuth(input: ProviderAuthPreparationOptions): ProviderAuthPrepared {
  const { runtimeRoot, hostEnvironment } = authPreparationContext(input)
  const profile = resolveHostProfilePaths(hostEnvironment)
  const hostSettings = snapshotClaudeHostSettings(profile)
  const claudeDir = join(runtimeRoot, '.claude')
  mkdirSync(claudeDir, { recursive: true })

  const envPatch = {
    ...buildRuntimeBaseEnv(runtimeRoot, hostEnvironment),
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
    mode: 'runtime-copy',
    runtimeRoot,
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

export function prepareOpenCodeAuth(input: ProviderAuthPreparationOptions): ProviderAuthPrepared {
  const { runtimeRoot, hostEnvironment } = authPreparationContext(input)
  const profile = resolveHostProfilePaths(hostEnvironment)
  const hostAuth = snapshotOpencodeHostAuth(profile)
  const materialized = materializeOpencodeAuth(runtimeRoot, profile)
  const layout = opencodeRuntimeLayout(runtimeRoot)

  const envPatch = {
    ...buildRuntimeBaseEnv(runtimeRoot, hostEnvironment),
    XDG_CONFIG_HOME: layout.configHome,
    XDG_DATA_HOME: layout.dataHome,
    XDG_STATE_HOME: layout.stateHome
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
    mode: 'runtime-copy',
    runtimeRoot,
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
