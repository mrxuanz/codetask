import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { applyWindowsCrashReporterEnv } from '../../agent-runtime/env'
import {
  resolveClaudeInstallDirs,
  resolveCodexHostAuthPath,
  resolveCodexInstallDirs,
  resolveCursorAgentInstallDirs,
  resolveCursorAgentMarkerWriteDirs,
  resolveCursorCompileCacheDirs,
  resolveDarwinKeychainReadRoots,
  resolveHostProfilePaths,
  resolveOpencodeInstallDirs,
  runtimeCodexHome,
  runtimeCursorConfigDir,
  runtimeCursorHome,
  snapshotCodexHostAuth,
  snapshotOpencodeHostAuth
} from './paths'
import {
  materializeCodexAuth,
  materializeCursorAuth,
  materializeOpencodeAuth,
  opencodeRuntimeLayout
} from './materialize'
import type { ProviderAuthDiagnostics, ProviderAuthPrepared } from './types'
import { processHostEnvironmentSource, type HostEnvironmentSnapshot } from '../../host-environment'

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
  const hostAuth = snapshotCodexHostAuth(profile)
  const hostAuthPath = resolveCodexHostAuthPath(profile)
  const materialized = materializeCodexAuth(runtimeRoot, profile)
  const codexHome = runtimeCodexHome(runtimeRoot)

  const envPatch = {
    ...buildRuntimeBaseEnv(runtimeRoot, hostEnvironment),
    CODEX_HOME: codexHome
  }
  const authMaterialPresent = materialized.authMaterialized || hostAuth.present

  const diagnostics: ProviderAuthDiagnostics = {
    provider: 'codex',
    mode: 'runtime-reference',
    authMaterialPresent,
    hostAuthPath,
    runtimeAuthPath: materialized.runtimeAuthPath,
    warnings: authMaterialPresent
      ? [
          'Codex uses a read-only reference to the exact host auth file; a sanitized runtime config projection keeps the host CLI model/provider while dropping MCP, plugins, projects, hooks, and trust settings.'
        ]
      : [
          materialized.configGenerated
            ? `Codex runtime model/provider config was generated, but no host login was found: ${hostAuthPath} (run codex login)`
            : `Host Codex login file not found: ${hostAuthPath} (run codex login)`
        ]
  }

  const readRoots = uniqueRoots([
    ...(existsSync(hostAuthPath) ? [hostAuthPath] : []),
    ...resolveCodexInstallDirs()
  ])
  return {
    mode: 'runtime-reference',
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
  const { runtimeRoot, workspaceRoot, hostEnvironment } = authPreparationContext(input)
  const profile = resolveHostProfilePaths(hostEnvironment)
  const materialized = materializeCursorAuth(runtimeRoot, workspaceRoot, profile)
  const runtimeEnv = buildRuntimeBaseEnv(runtimeRoot, hostEnvironment)
  const envPatch = {
    ...runtimeEnv,
    HOME: profile.home,
    CURSOR_CONFIG_DIR: runtimeCursorConfigDir(runtimeRoot),
    CURSOR_DATA_DIR: runtimeCursorHome(runtimeRoot)
  }

  const diagnostics: ProviderAuthDiagnostics = {
    provider: 'cursorcli',
    mode: 'host-identity',
    authMaterialPresent: materialized.authMaterialized,
    hostAuthPath: materialized.hostAuthPath,
    runtimeAuthPath: materialized.runtimeAuthPath,
    warnings: [
      materialized.authMaterialized
        ? 'Cursor keeps the host HOME only for macOS Keychain identity; exact host config files are read-only references, credentials are not copied, and Cursor/XDG state writes are redirected under runtime.'
        : 'Cursor host login was not detected from files (macOS may use Keychain); run `agent login`.',
      'ACP uses --force --sandbox disabled --approve-mcps --trust; temp files written to runtime.'
    ]
  }

  const readRoots = uniqueRoots([
    ...materialized.hostReferencePaths,
    ...resolveCursorCompileCacheDirs(profile),
    ...resolveDarwinKeychainReadRoots(profile),
    ...resolveCursorAgentInstallDirs()
  ])
  const writeRoots = uniqueRoots([...resolveCursorAgentMarkerWriteDirs(profile)])
  return {
    mode: 'host-identity',
    runtimeRoot,
    envPatch,
    readRoots,
    writeRoots,
    cleanupPlan: () => materialized.cleanup(),
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
      scrubPatterns: [
        '.cursor/cli-config.json',
        '.cursor/agent-cli-state.json',
        'config/cursor/cli-config.json',
        'config/cursor/acp-config.json',
        '.cursor/auth.json',
        'config/cursor/auth.json'
      ]
    }
  }
}

export function prepareClaudeAuth(input: ProviderAuthPreparationOptions): ProviderAuthPrepared {
  const { runtimeRoot, hostEnvironment } = authPreparationContext(input)
  const profile = resolveHostProfilePaths(hostEnvironment)
  const claudeDir = join(profile.home, '.claude')
  const claudeCredentials = join(claudeDir, '.credentials.json')
  const claudeJson = join(profile.home, '.claude.json')
  const envPatch = buildHostIdentityEnv(runtimeRoot, profile, hostEnvironment)
  const identityPaths = [claudeCredentials, claudeJson].filter((path) => existsSync(path))
  const authMaterialPresent = identityPaths.length > 0

  const diagnostics: ProviderAuthDiagnostics = {
    provider: 'claude-code',
    mode: 'host-identity',
    authMaterialPresent,
    hostAuthPath: claudeCredentials,
    runtimeAuthPath: claudeCredentials,
    warnings: [
      authMaterialPresent
        ? 'Claude uses exact read-only host identity files (plus macOS Keychain when present); environment-token credentials remain disabled.'
        : 'Claude host login identity was not detected; run `claude auth login`.',
      'The outer sandbox does not expose the full host Claude settings/session directory and never grants a task permission to mutate host credentials.',
      'Claude inner bypassPermissions + sandbox disabled; settingSources=[]; outer sandbox is the only boundary.'
    ]
  }

  const readRoots = uniqueRoots([
    ...identityPaths,
    ...resolveDarwinKeychainReadRoots(profile),
    ...resolveClaudeInstallDirs()
  ])
  const writeRoots: string[] = []
  return {
    mode: 'host-identity',
    runtimeRoot,
    envPatch,
    readRoots,
    writeRoots,
    cleanupPlan: () => undefined,
    diagnostics,
    filesystemProfile: {
      provider: 'claude-code',
      hostReadRoots: readRoots,
      hostWriteRoots: writeRoots,
      runtimeEnv: envPatch,
      credentialSnapshots: [],
      scrubPatterns: ['.claude/.credentials.json', '.claude.json']
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
    mode: 'runtime-reference',
    authMaterialPresent: materialized.authMaterialized || hostAuth.present,
    hostAuthPath: materialized.hostConfigDir,
    runtimeAuthPath: materialized.runtimeConfigDir,
    warnings: materialized.authMaterialized || materialized.configMaterialized
      ? [
          [...materialized.materializations, ...materialized.configMaterializations].every(
            (method) => method === 'reference' || method === 'projection'
          )
            ? 'OpenCode uses read-only references (or a sanitized provider/model projection) for host files. Host MCP, plugins, commands, Skills, prompts, and environment config are dropped.'
            : 'OpenCode host materialization mixed unexpected methods; credential file copies are forbidden.'
        ]
      : ['OpenCode host login files were not found; environment-token authentication is disabled.']
  }

  const readRoots = uniqueRoots([
    ...materialized.hostCredentialPaths,
    ...materialized.hostConfigPaths,
    ...resolveOpencodeInstallDirs()
  ])
  return {
    mode: 'runtime-reference',
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
