import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { rootCertificates } from 'tls'
import { applyWindowsCrashReporterEnv, buildSandboxAuthPassthrough } from '../agent-runtime/env'
import { snapshotHostEnv, stripCodeTaskTransientEnv } from '../providers/launch-env'
import { augmentPathWithHostNode } from './toolchain-path'
import { processHostEnvironmentSource, type HostEnvironmentSnapshot } from '../host-environment'
import { getShellChildEnvironment } from '../shell-child-environment'

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

function materializeSandboxTlsCaBundle(scratchRoot: string): string {
  const configDir = join(scratchRoot, 'config')
  const caPath = join(configDir, 'ca-bundle.pem')
  mkdirSync(configDir, { recursive: true })
  if (!existsSync(caPath)) {
    writeFileSync(caPath, `${rootCertificates.join('\n')}\n`, 'utf8')
  }
  return caPath
}

function applyWindowsSandboxSystemEnv(
  env: Record<string, string>,
  hostEnvironment: HostEnvironmentSnapshot,
  scratchRoot: string
): void {
  applyWindowsCrashReporterEnv(env)
  const hostHome = hostEnvironment.USERPROFILE ?? hostEnvironment.HOME ?? env.HOME
  if (!env.USERPROFILE && hostHome) env.USERPROFILE = hostHome
  if (!env.APPDATA && hostEnvironment.APPDATA) env.APPDATA = hostEnvironment.APPDATA
  if (!env.LOCALAPPDATA && hostEnvironment.LOCALAPPDATA) {
    env.LOCALAPPDATA = hostEnvironment.LOCALAPPDATA
  }
  if (!env.BREAKPAD_DUMP_LOCATION) {
    env.BREAKPAD_DUMP_LOCATION = join(scratchRoot, 'tmp', 'crashpad')
    mkdirSync(env.BREAKPAD_DUMP_LOCATION, { recursive: true })
  }
  for (const key of WINDOWS_SYSTEM_ENV_KEYS) {
    const value = hostEnvironment[key]
    if (value) env[key] = value
  }
  if (!env.HOMEDRIVE && hostHome && /^[A-Za-z]:/.test(hostHome)) {
    env.HOMEDRIVE = hostHome.slice(0, 2)
    env.HOMEPATH = hostHome.slice(2) || '\\'
  }
  env.SSL_CERT_FILE = materializeSandboxTlsCaBundle(scratchRoot)
}

/**
 * Sandbox child env: host identity + host TMP for SDK/ACP.
 * `scratchRoot` is OS-temp attestation scratch only — never a durable home redirect.
 */
export function buildSandboxEnv(input: {
  scratchRoot: string
  providerEnv?: Record<string, string> | undefined
  mcpToken?: string | undefined
}): Record<string, string> {
  const host = snapshotHostEnv()
  const hostEnvironment = processHostEnvironmentSource.snapshot()
  const providerEnv = stripCodeTaskTransientEnv({ ...(input.providerEnv ?? {}) })
  const hostHome = host.HOME ?? host.USERPROFILE ?? hostEnvironment.HOME ?? hostEnvironment.USERPROFILE
  const hostTmp =
    host.TMPDIR?.trim() ||
    host.TEMP?.trim() ||
    host.TMP?.trim() ||
    hostEnvironment.TMPDIR?.trim() ||
    hostEnvironment.TEMP?.trim() ||
    hostEnvironment.TMP?.trim() ||
    tmpdir()

  const env: Record<string, string> = {
    PATH: host.PATH ?? '',
    LANG: host.LANG ?? 'C.UTF-8',
    ...getShellChildEnvironment(),
    ...buildSandboxAuthPassthrough(),
    ...providerEnv
  }
  env.PATH = augmentPathWithHostNode(env.PATH)

  // SDK/ACP stay on host defaults — do not redirect HOME/XDG into CodeTask trees.
  if (hostHome) env.HOME = hostHome
  if (hostEnvironment.USERPROFILE) env.USERPROFILE = hostEnvironment.USERPROFILE
  if (hostEnvironment.APPDATA) env.APPDATA = hostEnvironment.APPDATA
  if (hostEnvironment.LOCALAPPDATA) env.LOCALAPPDATA = hostEnvironment.LOCALAPPDATA
  env.TMPDIR = hostTmp
  env.TEMP = hostTmp
  env.TMP = hostTmp

  mkdirSync(join(input.scratchRoot, 'tmp'), { recursive: true })

  if (process.platform === 'win32') {
    applyWindowsSandboxSystemEnv(env, hostEnvironment, input.scratchRoot)
  } else if (!env.SSL_CERT_FILE) {
    env.SSL_CERT_FILE = materializeSandboxTlsCaBundle(input.scratchRoot)
  }

  if (input.mcpToken) {
    env.MCP_BEARER_TOKEN = input.mcpToken
  }

  for (const name of BLOCKED_ENV) {
    delete env[name]
  }

  return env
}
