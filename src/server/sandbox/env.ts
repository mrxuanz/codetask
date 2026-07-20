import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { rootCertificates } from 'tls'
import {
  applyWindowsCrashReporterEnv,
  buildSandboxAuthPassthrough,
  ensureIsolatedProviderDirs
} from '../agent-runtime/env'
import { augmentPathWithHostNode } from './toolchain-path'

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

function applyWindowsSandboxSystemEnv(env: Record<string, string>, runtimeRoot: string): void {
  env.ELECTRON_RUN_AS_NODE = '1'
  applyWindowsCrashReporterEnv(env)
  if (!env.USERPROFILE) env.USERPROFILE = runtimeRoot
  if (!env.APPDATA) env.APPDATA = join(runtimeRoot, 'AppData', 'Roaming')
  if (!env.LOCALAPPDATA) env.LOCALAPPDATA = join(runtimeRoot, 'AppData', 'Local')
  if (!env.BREAKPAD_DUMP_LOCATION) {
    env.BREAKPAD_DUMP_LOCATION = join(runtimeRoot, 'tmp', 'crashpad')
  }
  for (const key of WINDOWS_SYSTEM_ENV_KEYS) {
    const value = process.env[key]
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
  mcpToken?: string | undefined
}): Record<string, string> {
  ensureIsolatedProviderDirs(input.runtimeRoot)

  const providerEnv = input.providerEnv ?? {}
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    LANG: process.env.LANG ?? 'C.UTF-8',
    CODETASK_OUTER_SANDBOX: '1',
    ...buildSandboxAuthPassthrough(),
    ...providerEnv
  }
  env.PATH = augmentPathWithHostNode(env.PATH)

  if (!env.CODETASK_RUNTIME_ROOT) {
    env.CODETASK_RUNTIME_ROOT = input.runtimeRoot
  }
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
    applyWindowsSandboxSystemEnv(env, input.runtimeRoot)
  } else {
    env.ELECTRON_RUN_AS_NODE = '1'
  }

  if (env.CODETASK_PROVIDER_AUTH_MODE === 'host-identity') {
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
