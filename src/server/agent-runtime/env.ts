import { mkdirSync } from 'fs'
import { join } from 'path'
import { resolveCursorWorkspaceProjectSlug } from './cursor-acp/cursor-workspace'
import { augmentPathWithHostNode } from '../sandbox/toolchain-path'
import { processHostEnvironmentSource } from '../host-environment'

const BLOCKED_ENV = [
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'DOCKER_HOST',
  'CONTAINER_HOST',
  'DBUS_SESSION_BUS_ADDRESS',
  'WAYLAND_DISPLAY',
  'DISPLAY',
  'GIT_ASKPASS'
] as const

const HOST_PROFILE_ENV_KEYS = new Set([
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'TMPDIR',
  'TEMP',
  'TMP',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME'
])

const PROVIDER_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CURSOR_API_KEY'
] as const

export const WINDOWS_CRASH_REPORTER_ENV: Record<string, string> = {
  ELECTRON_DISABLE_CRASH_REPORTER: '1',
  ELECTRON_ENABLE_LOGGING: '0',
  CHROME_CRASHPAD_HANDLER_PID: '0'
}

const WINDOWS_INHERITED_CRASH_REPORTER_ENV_KEYS = [
  'CHROME_CRASHPAD_PIPE_NAME',
  'CHROME_CRASHPAD_HANDLER_PID',
  'ELECTRON_CRASHPAD_PIPE_NAME',
  'CRASHPAD_HANDLER_PID'
] as const

function deleteEnvKeyCaseInsensitive(env: Record<string, string>, key: string): void {
  for (const existing of Object.keys(env)) {
    if (existing.toLowerCase() === key.toLowerCase()) {
      delete env[existing]
    }
  }
}

export function applyWindowsCrashReporterEnv(env: Record<string, string>): void {
  for (const key of WINDOWS_INHERITED_CRASH_REPORTER_ENV_KEYS) {
    deleteEnvKeyCaseInsensitive(env, key)
  }
  Object.assign(env, WINDOWS_CRASH_REPORTER_ENV)
}

const ELECTRON_CHILD_STRIP_ENV_KEYS = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ASAR',
  'ELECTRON_RENDERER_URL',
  'ELECTRON_ENABLE_LOGGING',
  'ELECTRON_DISABLE_CRASH_REPORTER',
  'ELECTRON_FORCE_WINDOW_MENU_BAR',
  'ELECTRON_EXTRA_LAUNCH_ARGS',
  'VSCODE_CRASH_REPORTER_PROCESS_TYPE'
] as const

export function stripElectronInheritedEnv(env: Record<string, string>): void {
  for (const key of ELECTRON_CHILD_STRIP_ENV_KEYS) {
    deleteEnvKeyCaseInsensitive(env, key)
  }
  if (process.platform === 'win32') {
    applyWindowsCrashReporterEnv(env)
  }
}

export interface ProviderChildEnvOptions {
  preserveHostIdentity?: boolean
}

const TASK_IDEMPOTENCY_ENV_KEY = 'CODETASK_TASK_IDEMPOTENCY_KEY'
const TASK_IDEMPOTENCY_SCOPE_ENV_KEY = 'CODETASK_TASK_IDEMPOTENCY_SCOPE'
const LOOPBACK_NO_PROXY_ENTRIES = ['127.0.0.1', 'localhost', '::1'] as const

/**
 * Keep CodeTask's loopback MCP traffic out of inherited HTTP proxies.
 *
 * Codex's Streamable HTTP MCP client honors conventional proxy variables. On
 * some hosts NO_PROXY is absent, incomplete, or only supplied in one casing,
 * which can route the local CodeTask MCP endpoint through an upstream proxy.
 * Merge both casings so the spawned CLI sees the same complete exclusion list.
 */
export function applyLoopbackNoProxyEnv(env: Record<string, string>): Record<string, string> {
  const entries: string[] = []
  const seen = new Set<string>()

  for (const value of [env.NO_PROXY, env.no_proxy]) {
    for (const raw of value?.split(',') ?? []) {
      const entry = raw.trim()
      if (!entry) continue
      const normalized = entry.toLowerCase()
      if (seen.has(normalized)) continue
      seen.add(normalized)
      entries.push(entry)
    }
  }

  for (const entry of LOOPBACK_NO_PROXY_ENTRIES) {
    if (seen.has(entry)) continue
    seen.add(entry)
    entries.push(entry)
  }

  const merged = entries.join(',')
  env.NO_PROXY = merged
  env.no_proxy = merged
  return env
}

/**
 * Add the durable logical-task identity to the environment consumed by the
 * Provider process.  This is deliberately applied at the last possible
 * boundary (the actual SDK/ACP child environment), rather than only keeping
 * the value in the in-process runner input where a provider cannot use it.
 */
export function applyTaskIdempotencyEnv(
  env: Record<string, string>,
  idempotencyKey?: string | null
): Record<string, string> {
  const key = idempotencyKey?.trim()
  if (!key) {
    delete env[TASK_IDEMPOTENCY_ENV_KEY]
    delete env[TASK_IDEMPOTENCY_SCOPE_ENV_KEY]
    return env
  }

  env[TASK_IDEMPOTENCY_ENV_KEY] = key
  env[TASK_IDEMPOTENCY_SCOPE_ENV_KEY] = 'logical-task'
  return env
}

export function ensureCursorAcpRuntimeDirs(runtimeRoot: string, workspaceCwd?: string): void {
  ensureIsolatedProviderDirs(runtimeRoot)
  const cwd = workspaceCwd?.trim()
  if (!cwd) return
  mkdirSync(join(runtimeRoot, '.cursor', 'projects', resolveCursorWorkspaceProjectSlug(cwd)), {
    recursive: true
  })
}

export function ensureIsolatedProviderDirs(runtimeRoot: string): void {
  mkdirSync(join(runtimeRoot, 'tmp'), { recursive: true })
  mkdirSync(join(runtimeRoot, 'config'), { recursive: true })
  mkdirSync(join(runtimeRoot, 'cache'), { recursive: true })
  mkdirSync(join(runtimeRoot, 'data'), { recursive: true })
  if (process.platform !== 'win32') return
  mkdirSync(join(runtimeRoot, 'AppData', 'Roaming'), { recursive: true })
  mkdirSync(join(runtimeRoot, 'AppData', 'Local'), { recursive: true })
  mkdirSync(join(runtimeRoot, 'AppData', 'Local', 'CrashDumps'), { recursive: true })
  mkdirSync(join(runtimeRoot, 'tmp', 'crashpad'), { recursive: true })
  mkdirSync(join(runtimeRoot, '.claude'), { recursive: true })
  mkdirSync(join(runtimeRoot, '.codex'), { recursive: true })
}

function applyIsolatedWindowsProfile(runtimeRoot: string, env: Record<string, string>): void {
  const appData = join(runtimeRoot, 'AppData', 'Roaming')
  const localAppData = join(runtimeRoot, 'AppData', 'Local')
  const tmp = join(runtimeRoot, 'tmp')
  const crashpad = join(tmp, 'crashpad')
  mkdirSync(crashpad, { recursive: true })

  env.HOME = runtimeRoot
  env.USERPROFILE = runtimeRoot
  env.APPDATA = appData
  env.LOCALAPPDATA = localAppData
  env.TMPDIR = tmp
  env.TEMP = tmp
  env.TMP = tmp
  if (/^[A-Za-z]:/.test(runtimeRoot)) {
    env.HOMEDRIVE = runtimeRoot.slice(0, 2)
    env.HOMEPATH = runtimeRoot.slice(2) || '\\'
  }
  env.XDG_CONFIG_HOME = join(runtimeRoot, 'config')
  env.XDG_CACHE_HOME = join(runtimeRoot, 'cache')
  env.XDG_DATA_HOME = join(runtimeRoot, 'data')
  env.CLAUDE_CONFIG_DIR = join(runtimeRoot, '.claude')
  env.BREAKPAD_DUMP_LOCATION = crashpad
  applyWindowsCrashReporterEnv(env)
}

function copyHostAuthEnv(
  env: Record<string, string>,
  hostEnvironment = processHostEnvironmentSource.snapshot()
): void {
  for (const key of PROVIDER_AUTH_ENV_KEYS) {
    const value = hostEnvironment[key]
    if (typeof value === 'string' && value.trim()) {
      env[key] = value
    }
  }
}

export function buildSandboxPreparedProviderEnv(): Record<string, string> {
  const env: Record<string, string> = { ...processHostEnvironmentSource.snapshot() }
  env.PATH = augmentPathWithHostNode(env.PATH)

  for (const name of BLOCKED_ENV) {
    delete env[name]
  }

  if (process.platform === 'win32') {
    applyWindowsCrashReporterEnv(env)
  }

  return env
}

export function buildProviderChildEnv(
  runtimeRoot: string,
  options?: ProviderChildEnvOptions
): Record<string, string> {
  const preserveHost = options?.preserveHostIdentity ?? true
  ensureIsolatedProviderDirs(runtimeRoot)
  const hostEnvironment = processHostEnvironmentSource.snapshot()

  const hostHome =
    hostEnvironment.HOME ?? hostEnvironment.USERPROFILE ?? hostEnvironment.HOMEPATH ?? runtimeRoot

  const env: Record<string, string> = {
    PATH: augmentPathWithHostNode(hostEnvironment.PATH, { env: hostEnvironment }),
    LANG: hostEnvironment.LANG ?? 'C.UTF-8'
  }

  if (preserveHost) {
    env.HOME = hostHome
    if (hostEnvironment.USERPROFILE) env.USERPROFILE = hostEnvironment.USERPROFILE
    if (hostEnvironment.HOMEDRIVE) env.HOMEDRIVE = hostEnvironment.HOMEDRIVE
    if (hostEnvironment.HOMEPATH) env.HOMEPATH = hostEnvironment.HOMEPATH
    if (hostEnvironment.APPDATA) env.APPDATA = hostEnvironment.APPDATA
    if (hostEnvironment.LOCALAPPDATA) env.LOCALAPPDATA = hostEnvironment.LOCALAPPDATA
    env.TMPDIR = hostEnvironment.TMPDIR ?? hostEnvironment.TEMP ?? join(runtimeRoot, 'tmp')
  } else if (process.platform === 'win32') {
    applyIsolatedWindowsProfile(runtimeRoot, env)
  } else {
    env.HOME = runtimeRoot
    env.TMPDIR = join(runtimeRoot, 'tmp')
    env.XDG_CONFIG_HOME = join(runtimeRoot, 'config')
    env.XDG_CACHE_HOME = join(runtimeRoot, 'cache')
    env.XDG_DATA_HOME = join(runtimeRoot, 'data')
  }

  for (const [key, value] of Object.entries(hostEnvironment)) {
    if (typeof value !== 'string') continue
    if (key in env) continue
    if (!preserveHost && HOST_PROFILE_ENV_KEYS.has(key)) continue
    env[key] = value
  }

  copyHostAuthEnv(env, hostEnvironment)

  for (const name of BLOCKED_ENV) {
    delete env[name]
  }

  if (process.platform === 'win32') {
    applyWindowsCrashReporterEnv(env)
  }

  return env
}

export function buildSandboxAuthPassthrough(): Record<string, string> {
  const env: Record<string, string> = {}
  copyHostAuthEnv(env)
  return env
}
