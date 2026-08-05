import { augmentPathWithHostNode } from './toolchain-path.ts'
import { processHostEnvironmentSource } from '@codetask/agent-runtime/host-environment'
import { stripProviderHostConfiguration } from './providers/environment.ts'
import { SERIALIZED_SHELL_CHILD_ENV } from '@codetask/agent-runtime/shell-child-environment'

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

/**
 * Child env for provider SDK/ACP turns: host identity + host TMP/XDG defaults.
 * Does not redirect durable provider data into any CodeTask scratch tree.
 */
export function buildProviderChildEnv(_unused?: string): Record<string, string> {
  void _unused
  const hostEnvironment = stripProviderHostConfiguration(processHostEnvironmentSource.snapshot())

  const hostHome =
    hostEnvironment.HOME ?? hostEnvironment.USERPROFILE ?? hostEnvironment.HOMEPATH ?? ''

  const env: Record<string, string> = {
    PATH: augmentPathWithHostNode(hostEnvironment.PATH, { env: hostEnvironment }),
    LANG: hostEnvironment.LANG ?? 'C.UTF-8'
  }

  if (hostHome) env.HOME = hostHome
  if (hostEnvironment.USERPROFILE) env.USERPROFILE = hostEnvironment.USERPROFILE
  if (hostEnvironment.HOMEDRIVE) env.HOMEDRIVE = hostEnvironment.HOMEDRIVE
  if (hostEnvironment.HOMEPATH) env.HOMEPATH = hostEnvironment.HOMEPATH
  if (hostEnvironment.APPDATA) env.APPDATA = hostEnvironment.APPDATA
  if (hostEnvironment.LOCALAPPDATA) env.LOCALAPPDATA = hostEnvironment.LOCALAPPDATA

  const hostTmp =
    hostEnvironment.TMPDIR?.trim() || hostEnvironment.TEMP?.trim() || hostEnvironment.TMP?.trim()
  if (hostTmp) {
    env.TMPDIR = hostTmp
    env.TEMP = hostTmp
    env.TMP = hostTmp
  }

  for (const [key, value] of Object.entries(hostEnvironment)) {
    if (typeof value !== 'string') continue
    if (key in env) continue
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
