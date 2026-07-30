import { mkdirSync } from 'fs'
import { join } from 'path'
import { augmentPathWithHostNode } from '../sandbox/toolchain-path'
import { processHostEnvironmentSource } from '../host-environment'
import { stripProviderHostConfiguration } from '../providers/environment'
import { SERIALIZED_SHELL_CHILD_ENV } from '../shell-child-environment'

const BLOCKED_ENV = [
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'DOCKER_HOST',
  'CONTAINER_HOST',
  'DBUS_SESSION_BUS_ADDRESS',
  'WAYLAND_DISPLAY',
  'DISPLAY',
  'GIT_ASKPASS',
  SERIALIZED_SHELL_CHILD_ENV
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
 * CodeTask scratch for outer OS-sandbox turns (attestation / CA materialization).
 * Host-identity SDK/ACP data stays on host defaults — do not pre-create provider trees.
 */
export function ensureIsolatedProviderDirs(runtimeRoot: string): void {
  mkdirSync(join(runtimeRoot, 'tmp'), { recursive: true })
}

function applyIsolatedWindowsProfile(runtimeRoot: string, env: Record<string, string>): void {
  const appData = join(runtimeRoot, 'AppData', 'Roaming')
  const localAppData = join(runtimeRoot, 'AppData', 'Local')
  const tmp = join(runtimeRoot, 'tmp')
  const crashpad = join(tmp, 'crashpad')
  mkdirSync(appData, { recursive: true })
  mkdirSync(localAppData, { recursive: true })
  mkdirSync(join(localAppData, 'CrashDumps'), { recursive: true })
  mkdirSync(crashpad, { recursive: true })
  mkdirSync(join(runtimeRoot, 'config'), { recursive: true })
  mkdirSync(join(runtimeRoot, 'cache'), { recursive: true })
  mkdirSync(join(runtimeRoot, 'data'), { recursive: true })
  mkdirSync(join(runtimeRoot, '.claude'), { recursive: true })

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

export function buildSandboxPreparedProviderEnv(): Record<string, string> {
  const env = stripProviderHostConfiguration(processHostEnvironmentSource.snapshot())
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
  if (!preserveHost) {
    ensureIsolatedProviderDirs(runtimeRoot)
  }
  const hostEnvironment = stripProviderHostConfiguration(processHostEnvironmentSource.snapshot())

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
    // Host TMP/XDG defaults — do not redirect SDK/ACP durable or temp data into runtimeRoot.
    const hostTmp =
      hostEnvironment.TMPDIR?.trim() ||
      hostEnvironment.TEMP?.trim() ||
      hostEnvironment.TMP?.trim()
    if (hostTmp) {
      env.TMPDIR = hostTmp
      env.TEMP = hostTmp
      env.TMP = hostTmp
    }
  } else if (process.platform === 'win32') {
    applyIsolatedWindowsProfile(runtimeRoot, env)
  } else {
    mkdirSync(join(runtimeRoot, 'config'), { recursive: true })
    mkdirSync(join(runtimeRoot, 'cache'), { recursive: true })
    mkdirSync(join(runtimeRoot, 'data'), { recursive: true })
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

  for (const name of BLOCKED_ENV) {
    delete env[name]
  }

  if (process.platform === 'win32') {
    applyWindowsCrashReporterEnv(env)
  }

  return env
}

export function buildSandboxAuthPassthrough(): Record<string, string> {
  return {}
}
