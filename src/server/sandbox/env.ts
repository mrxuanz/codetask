import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { rootCertificates } from 'tls'
import {
  applyWindowsCrashReporterEnv,
  buildSandboxAuthPassthrough,
  ensureIsolatedProviderDirs
} from '../agent-runtime/env'
import { snapshotHostEnv, stripCodeTaskTransientEnv } from '../providers/launch-env'
import { augmentPathWithHostNode } from './toolchain-path'
import type { ProviderAuthMode } from './provider-auth/types'
import {
  processHostEnvironmentSource,
  type HostEnvironmentSnapshot
} from '../host-environment'

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

const WINDOWS_SYSTEM_ENV_KEYS = [
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'PROGRAMDATA',
  'ProgramData',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'COMMONPROGRAMFILES',
  'PUBLIC',
  'ALLUSERSPROFILE'
] as const

function materializeSandboxTlsCaBundle(runtimeRoot: string): string {
  const configDir = join(runtimeRoot, 'config')
  const caPath = join(configDir, 'ca-bundle.pem')
  mkdirSync(configDir, { recursive: true })
  if (!existsSync(caPath)) {
    writeFileSync(caPath, `${rootCertificates.join('\n')}\n`, 'utf8')
  }
  return caPath
}

function applyWindowsSandboxSystemEnv(
  env: Record<string, string>,
  runtimeRoot: string,
  hostEnvironment: HostEnvironmentSnapshot
): void {
  env.ELECTRON_RUN_AS_NODE = '1'
  applyWindowsCrashReporterEnv(env)
  if (!env.USERPROFILE) env.USERPROFILE = runtimeRoot
  if (!env.APPDATA) env.APPDATA = join(runtimeRoot, 'AppData', 'Roaming')
  if (!env.LOCALAPPDATA) env.LOCALAPPDATA = join(runtimeRoot, 'AppData', 'Local')
  if (!env.BREAKPAD_DUMP_LOCATION) {
    env.BREAKPAD_DUMP_LOCATION = join(runtimeRoot, 'tmp', 'crashpad')
  }
  for (const key of WINDOWS_SYSTEM_ENV_KEYS) {
    const value = hostEnvironment[key]
    if (value) env[key] = value
  }
  if (!env.HOMEDRIVE && /^[A-Za-z]:/.test(env.HOME ?? runtimeRoot)) {
    const home = env.HOME ?? runtimeRoot
    env.HOMEDRIVE = home.slice(0, 2)
    env.HOMEPATH = home.slice(2) || '\\'
  }
  env.SSL_CERT_FILE = materializeSandboxTlsCaBundle(runtimeRoot)
}

export function buildSandboxEnv(input: {
  runtimeRoot: string
  providerEnv?: Record<string, string> | undefined
  authMode?: ProviderAuthMode | undefined
  mcpToken?: string | undefined
}): Record<string, string> {
  ensureIsolatedProviderDirs(input.runtimeRoot)

  const host = snapshotHostEnv()
  const providerEnv = stripCodeTaskTransientEnv({ ...(input.providerEnv ?? {}) })
  const env: Record<string, string> = {
    PATH: host.PATH ?? '',
    LANG: host.LANG ?? 'C.UTF-8',
    ...buildSandboxAuthPassthrough(),
    ...providerEnv
  }
  env.PATH = augmentPathWithHostNode(env.PATH)

  if (!env.HOME) {
    env.HOME = input.runtimeRoot
    env.TMPDIR = join(input.runtimeRoot, 'tmp')
    env.TEMP = join(input.runtimeRoot, 'tmp')
    env.TMP = join(input.runtimeRoot, 'tmp')
    env.XDG_CONFIG_HOME = join(input.runtimeRoot, 'config')
    env.XDG_CACHE_HOME = join(input.runtimeRoot, 'cache')
    env.XDG_DATA_HOME = join(input.runtimeRoot, 'data')
  }

  if (process.platform === 'win32') {
    applyWindowsSandboxSystemEnv(env, input.runtimeRoot, processHostEnvironmentSource.snapshot())
  } else {
    env.ELECTRON_RUN_AS_NODE = '1'
  }

  if (input.authMode === 'host-identity') {
    delete env.CLAUDE_CONFIG_DIR
  }

  if (input.mcpToken) {
    env.MCP_BEARER_TOKEN = input.mcpToken
  }

  for (const name of BLOCKED_ENV) {
    delete env[name]
  }

  return env
}
