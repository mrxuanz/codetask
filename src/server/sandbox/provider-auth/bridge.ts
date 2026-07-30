import { existsSync, mkdirSync } from 'fs'
import { dirname, isAbsolute, join, normalize, parse, relative, sep } from 'path'
import { applyWindowsCrashReporterEnv } from '../../agent-runtime/env'
import type { SupportedCoreCode } from '../../conversation/cores'
import { processHostEnvironmentSource, type HostEnvironmentSnapshot } from '../../host-environment'
import {
  resolveClaudeHostConfigDir,
  resolveClaudeInstallDirs,
  resolveCodexInstallDirs,
  resolveCursorAgentInstallDirs,
  resolveCursorAgentMarkerWriteDirs,
  resolveCursorCompileCacheDirs,
  resolveCursorHostConfigDir,
  resolveDarwinKeychainReadRoots,
  resolveHostProfilePaths,
  resolveOpencodeInstallDirs,
  snapshotCodexHostAuth,
  snapshotCursorHostAuth,
  snapshotOpencodeHostAuth
} from './paths'
import {
  PROVIDER_RUNTIME_PROFILE_SCHEMA_VERSION,
  type ProviderPathGrant,
  type ProviderPathGrantAccess,
  type ProviderPathGrantKind,
  type ProviderRuntimeDiagnostics,
  type ProviderRuntimePlatform,
  type ProviderRuntimeProfile
} from './types'

const SUPPORTED_RUNTIME_PLATFORMS = new Set<NodeJS.Platform>(['darwin', 'linux', 'win32'])

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

export interface ProviderRuntimePreparationOptions {
  readonly runtimeRoot: string
  readonly workspaceRoot?: string | undefined
  readonly hostEnvironment?: HostEnvironmentSnapshot | undefined
  readonly platform?: NodeJS.Platform | undefined
}

interface RuntimePreparationContext {
  runtimeRoot: string
  workspaceRoot: string
  hostEnvironment: HostEnvironmentSnapshot
  platform: ProviderRuntimePlatform
}

function runtimePreparationContext(
  input: ProviderRuntimePreparationOptions
): RuntimePreparationContext {
  const platform = input.platform ?? process.platform
  if (!SUPPORTED_RUNTIME_PLATFORMS.has(platform)) {
    throw new Error(`provider_runtime.unsupported_platform: ${platform}`)
  }
  return {
    runtimeRoot: input.runtimeRoot,
    workspaceRoot: input.workspaceRoot ?? input.runtimeRoot,
    hostEnvironment: input.hostEnvironment ?? processHostEnvironmentSource.snapshot(),
    platform: platform as ProviderRuntimePlatform
  }
}

function copySelectedHostEnv(
  env: Record<string, string>,
  hostEnvironment: HostEnvironmentSnapshot
): void {
  for (const key of HOST_EXECUTION_ENV_KEYS) {
    const value = hostEnvironment[key]
    if (typeof value === 'string' && value.trim()) env[key] = value
  }
}

function buildRuntimeBaseEnv(
  runtimeRoot: string,
  hostEnvironment: HostEnvironmentSnapshot,
  platform: ProviderRuntimePlatform
): Record<string, string> {
  const tmp = join(runtimeRoot, 'tmp')
  const config = join(runtimeRoot, 'config')
  const cache = join(runtimeRoot, 'cache')
  const data = join(runtimeRoot, 'data')
  const state = join(runtimeRoot, 'state')
  for (const path of [tmp, config, cache, data, state]) {
    mkdirSync(path, { recursive: true })
  }

  const env: Record<string, string> = {
    HOME: runtimeRoot,
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp
  }
  copySelectedHostEnv(env, hostEnvironment)

  if (platform === 'win32') {
    env.USERPROFILE = runtimeRoot
    env.APPDATA = join(runtimeRoot, 'AppData', 'Roaming')
    env.LOCALAPPDATA = join(runtimeRoot, 'AppData', 'Local')
    mkdirSync(env.APPDATA, { recursive: true })
    mkdirSync(env.LOCALAPPDATA, { recursive: true })
    if (/^[A-Za-z]:/.test(runtimeRoot)) {
      env.HOMEDRIVE = runtimeRoot.slice(0, 2)
      env.HOMEPATH = runtimeRoot.slice(2) || '\\'
    }
    applyWindowsCrashReporterEnv(env)
  } else {
    env.XDG_CONFIG_HOME = config
    env.XDG_CACHE_HOME = cache
    env.XDG_DATA_HOME = data
    env.XDG_STATE_HOME = state
  }
  return env
}

function grant(
  path: string,
  access: ProviderPathGrantAccess,
  kind: ProviderPathGrantKind,
  reason: string
): ProviderPathGrant | null {
  if (!path.trim() || !existsSync(path)) return null
  const normalized = normalize(path)
  if (normalized === parse(normalized).root) {
    throw new Error(`provider_runtime.unsafe_host_grant: ${normalized}`)
  }
  return { path: normalized, access, kind, reason }
}

function uniqueGrants(grants: Array<ProviderPathGrant | null>): ProviderPathGrant[] {
  const byPath = new Map<string, ProviderPathGrant>()
  for (const candidate of grants) {
    if (!candidate) continue
    const key = candidate.path.toLowerCase()
    const previous = byPath.get(key)
    if (!previous || candidate.access === 'read-write') byPath.set(key, candidate)
  }
  const ordered = [...byPath.values()].sort((left, right) => left.path.length - right.path.length)
  return ordered.filter((candidate, index) => {
    return !ordered.slice(0, index).some((parent) => {
      const child = relative(parent.path, candidate.path)
      const contains =
        child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
      if (!contains) return false
      return parent.access === 'read-write' || candidate.access === 'read'
    })
  })
}

function executableGrants(
  paths: readonly string[],
  provider: string
): Array<ProviderPathGrant | null> {
  return paths.map((path) => grant(path, 'read', 'executable', `${provider} SDK/CLI installation`))
}

function makeProfile(input: {
  provider: ProviderRuntimeProfile['provider']
  context: RuntimePreparationContext
  environment: Record<string, string>
  hostPathGrants: Array<ProviderPathGrant | null>
  diagnostics: ProviderRuntimeDiagnostics
}): ProviderRuntimeProfile {
  const profile = resolveHostProfilePaths(input.context.hostEnvironment, input.context.platform)
  const hostPathGrants = uniqueGrants(input.hostPathGrants)
  for (const item of hostPathGrants) {
    if (normalize(item.path).toLowerCase() === normalize(profile.home).toLowerCase()) {
      throw new Error(`provider_runtime.full_home_grant_forbidden: ${input.provider}`)
    }
  }
  return {
    schemaVersion: PROVIDER_RUNTIME_PROFILE_SCHEMA_VERSION,
    provider: input.provider,
    platform: input.context.platform,
    mode: 'host-identity',
    runtimeRoot: input.context.runtimeRoot,
    stateRoot: input.context.runtimeRoot,
    environment: input.environment,
    hostPathGrants,
    diagnostics: input.diagnostics
  }
}

export function prepareCodexRuntimeProfile(
  input: ProviderRuntimePreparationOptions
): ProviderRuntimeProfile {
  const context = runtimePreparationContext(input)
  const hostProfile = resolveHostProfilePaths(context.hostEnvironment, context.platform)
  const hostIdentity = snapshotCodexHostAuth(hostProfile)
  const environment: Record<string, string> = {
    ...buildRuntimeBaseEnv(context.runtimeRoot, context.hostEnvironment, context.platform),
    CODEX_HOME: hostIdentity.codexHome
  }
  const diagnostics: ProviderRuntimeDiagnostics = {
    provider: 'codex',
    mode: 'host-identity',
    authMaterialPresent: hostIdentity.present,
    primaryIdentityPath: join(hostIdentity.codexHome, 'auth.json'),
    warnings: hostIdentity.present
      ? [
          'Codex uses its native host identity namespace directly. The sandbox grants only .codex, never the full host HOME; no credential copy, symlink, projection, or cleanup artifact is created.'
        ]
      : [`Host Codex login file not found; run codex login.`]
  }

  return makeProfile({
    provider: 'codex',
    context,
    environment,
    hostPathGrants: [
      grant(
        hostIdentity.codexHome,
        hostIdentity.present ? 'read-write' : 'read',
        'identity',
        'Codex login refresh and native session continuity'
      ),
      ...executableGrants(resolveCodexInstallDirs(), 'Codex')
    ],
    diagnostics
  })
}

export function prepareCursorRuntimeProfile(
  input: ProviderRuntimePreparationOptions
): ProviderRuntimeProfile {
  const context = runtimePreparationContext(input)
  const hostProfile = resolveHostProfilePaths(context.hostEnvironment, context.platform)
  const hostIdentity = snapshotCursorHostAuth(hostProfile, context.platform)
  const configDir = resolveCursorHostConfigDir(hostProfile, context.platform)
  const environment: Record<string, string> = {
    ...buildRuntimeBaseEnv(context.runtimeRoot, context.hostEnvironment, context.platform),
    HOME: hostProfile.home,
    CURSOR_CONFIG_DIR: configDir,
    CURSOR_DATA_DIR: join(context.runtimeRoot, '.cursor')
  }
  if (context.platform === 'win32') {
    environment.USERPROFILE = hostProfile.home
    environment.APPDATA = hostProfile.appData
  }

  const keychainRoots = resolveDarwinKeychainReadRoots(hostProfile, context.platform)
  const authMaterialPresent =
    hostIdentity.present || (context.platform === 'darwin' && keychainRoots.length > 0)
  const sourceGrants = hostIdentity.sources.map((path) =>
    grant(
      path,
      path.startsWith(configDir) || path === hostIdentity.authPath ? 'read-write' : 'read',
      path === hostIdentity.authPath ? 'identity' : 'configuration',
      path === hostIdentity.authPath
        ? 'Cursor login refresh'
        : 'Cursor native CLI/ACP configuration'
    )
  )

  return makeProfile({
    provider: 'cursorcli',
    context,
    environment,
    hostPathGrants: [
      grant(configDir, 'read-write', 'identity', 'Cursor configuration identity and token refresh'),
      ...sourceGrants,
      ...resolveCursorCompileCacheDirs(hostProfile, context.platform).map((path) =>
        grant(path, 'read', 'runtime-compatibility', 'Cursor compiler cache')
      ),
      ...keychainRoots.map((path) =>
        grant(path, 'read', 'platform-credential-store', 'macOS Keychain-backed Cursor identity')
      ),
      ...resolveCursorAgentMarkerWriteDirs(hostProfile, context.platform).map((path) =>
        grant(path, 'read-write', 'runtime-compatibility', 'Cursor agent running marker')
      ),
      ...executableGrants(resolveCursorAgentInstallDirs(hostProfile, context.platform), 'Cursor')
    ],
    diagnostics: {
      provider: 'cursorcli',
      mode: 'host-identity',
      authMaterialPresent,
      primaryIdentityPath: hostIdentity.authPath,
      warnings: [
        authMaterialPresent
          ? 'Cursor reads its native host identity paths while CURSOR_DATA_DIR keeps project metadata and MCP approvals inside the private runtime.'
          : 'Cursor host login was not detected; run `agent login`.',
        'ACP uses --force --sandbox disabled --approve-mcps --trust; the outer OS sandbox remains authoritative.'
      ]
    }
  })
}

export function prepareClaudeRuntimeProfile(
  input: ProviderRuntimePreparationOptions
): ProviderRuntimeProfile {
  const context = runtimePreparationContext(input)
  const hostProfile = resolveHostProfilePaths(context.hostEnvironment, context.platform)
  const claudeDir = resolveClaudeHostConfigDir(hostProfile)
  const identityCandidates = [
    join(claudeDir, '.credentials.json'),
    join(claudeDir, '.claude.json'),
    join(hostProfile.home, '.claude.json')
  ]
  const identityPaths = identityCandidates.filter((path) => existsSync(path))
  const keychainRoots = resolveDarwinKeychainReadRoots(hostProfile, context.platform)
  const authMaterialPresent =
    identityPaths.length > 0 || (context.platform === 'darwin' && keychainRoots.length > 0)
  const environment: Record<string, string> = {
    ...buildRuntimeBaseEnv(context.runtimeRoot, context.hostEnvironment, context.platform),
    HOME: hostProfile.home,
    CLAUDE_CONFIG_DIR: claudeDir
  }
  if (context.platform === 'win32') {
    environment.USERPROFILE = hostProfile.home
    environment.CLAUDE_SECURESTORAGE_CONFIG_DIR = claudeDir
  }

  return makeProfile({
    provider: 'claude-code',
    context,
    environment,
    hostPathGrants: [
      grant(
        claudeDir,
        'read-write',
        'identity',
        'Claude native login refresh and resumable session storage'
      ),
      ...identityPaths
        .filter((path) => !path.startsWith(claudeDir))
        .map((path) =>
          grant(path, 'read-write', 'identity', 'Claude legacy host identity metadata')
        ),
      ...keychainRoots.map((path) =>
        grant(path, 'read', 'platform-credential-store', 'macOS Keychain-backed Claude identity')
      ),
      ...executableGrants(resolveClaudeInstallDirs(), 'Claude Code')
    ],
    diagnostics: {
      provider: 'claude-code',
      mode: 'host-identity',
      authMaterialPresent,
      primaryIdentityPath: identityPaths[0] ?? claudeDir,
      warnings: [
        authMaterialPresent
          ? 'Claude uses its native host identity namespace directly; no credential is copied into runtime.'
          : 'Claude host login identity was not detected; run `claude auth login`.',
        'settingSources=[] still blocks host settings, hooks, Skills, and project policy from being loaded by the SDK.'
      ]
    }
  })
}

export function prepareOpenCodeRuntimeProfile(
  input: ProviderRuntimePreparationOptions
): ProviderRuntimeProfile {
  const context = runtimePreparationContext(input)
  const hostProfile = resolveHostProfilePaths(context.hostEnvironment, context.platform)
  const hostIdentity = snapshotOpencodeHostAuth(hostProfile, context.platform)
  const environment = buildRuntimeBaseEnv(
    context.runtimeRoot,
    context.hostEnvironment,
    context.platform
  )
  environment.XDG_CONFIG_HOME = dirname(hostIdentity.configDir)
  environment.XDG_DATA_HOME = dirname(hostIdentity.dataDir)
  if (context.platform === 'win32') {
    environment.APPDATA = dirname(hostIdentity.configDir)
    environment.LOCALAPPDATA = dirname(hostIdentity.dataDir)
  }

  const configContainsIdentity = hostIdentity.sources.some(
    (path) =>
      path.startsWith(hostIdentity.configDir) &&
      (path.endsWith('auth.json') || path.endsWith('credentials.json'))
  )

  return makeProfile({
    provider: 'opencode',
    context,
    environment,
    hostPathGrants: [
      grant(
        hostIdentity.configDir,
        configContainsIdentity ? 'read-write' : 'read',
        configContainsIdentity ? 'identity' : 'configuration',
        configContainsIdentity
          ? 'OpenCode legacy config identity refresh'
          : 'OpenCode provider/model configuration'
      ),
      grant(
        hostIdentity.dataDir,
        'read-write',
        'identity',
        'OpenCode login refresh and native durable session database'
      ),
      ...executableGrants(resolveOpencodeInstallDirs(), 'OpenCode')
    ],
    diagnostics: {
      provider: 'opencode',
      mode: 'host-identity',
      authMaterialPresent: hostIdentity.present,
      primaryIdentityPath: hostIdentity.sources.find(
        (path) => path.endsWith('auth.json') || path.endsWith('credentials.json')
      ),
      warnings: hostIdentity.present
        ? [
            'OpenCode uses its native config/data namespaces directly. Cache, state, and temp remain private to this runtime; no credential or configuration projection is written.'
          ]
        : [
            'OpenCode host login files were not found; environment-token authentication is disabled.'
          ]
    }
  })
}

export function prepareProviderRuntimeProfile(
  provider: SupportedCoreCode,
  runtimeRoot: string,
  options: Omit<ProviderRuntimePreparationOptions, 'runtimeRoot'> = {}
): ProviderRuntimeProfile {
  const input = { ...options, runtimeRoot }
  switch (provider) {
    case 'codex':
      return prepareCodexRuntimeProfile(input)
    case 'cursorcli':
      return prepareCursorRuntimeProfile(input)
    case 'claude-code':
      return prepareClaudeRuntimeProfile(input)
    case 'opencode':
      return prepareOpenCodeRuntimeProfile(input)
  }
}
