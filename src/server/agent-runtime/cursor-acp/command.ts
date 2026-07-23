import {
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptions
} from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join, normalize } from 'node:path'
import { spawnProviderCommandSync, spawnProviderInvocation } from '../../providers/spawn'
import { processHostEnvironmentSource } from '../../host-environment'

type StringEnv = Record<string, string | undefined>

const nodeRequire = createRequire(import.meta.url)

const WINDOWS_AGENT_BIN_NAMES = [
  'agent.cmd',
  'agent.exe',
  'agent.ps1',
  'cursor-agent.cmd',
  'cursor-agent.exe',
  'cursor-agent.ps1'
] as const

function cleanCommand(command: string): string {
  return command.trim().replace(/^"|"$/g, '') || 'agent'
}

function hasPathSeparator(command: string): boolean {
  return /[\\/]/.test(command)
}

function envValue(env: StringEnv, key: string): string | undefined {
  const exact = env[key]
  if (typeof exact === 'string') return exact
  const actualKey = Object.keys(env).find((name) => name.toLowerCase() === key.toLowerCase())
  const value = actualKey ? env[actualKey] : undefined
  return typeof value === 'string' ? value : undefined
}

function withProcessEnv(
  env: StringEnv = processHostEnvironmentSource.snapshot()
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...processHostEnvironmentSource.snapshot() }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') merged[key] = value
  }
  return merged
}

function resolveHostHome(env: StringEnv): string | undefined {
  return envValue(env, 'USERPROFILE') || envValue(env, 'HOME')
}

function resolveHostLocalAppData(env: StringEnv): string | undefined {
  const explicit = envValue(env, 'LOCALAPPDATA')
  if (explicit) return explicit
  const home = resolveHostHome(env)
  return home ? join(home, 'AppData', 'Local') : undefined
}

function resolveKnownCursorAgentDirs(env: StringEnv): string[] {
  if (process.platform !== 'win32') return []

  const localAppData = resolveHostLocalAppData(env)
  if (!localAppData) return []
  return [join(localAppData, 'cursor-agent'), join(localAppData, 'Programs', 'cursor-agent')]
}

function commandCandidates(command: string): readonly string[] {
  const lower = command.toLowerCase()
  if (lower === 'cursor-agent') {
    return [
      'cursor-agent.cmd',
      'cursor-agent.exe',
      'cursor-agent.ps1',
      'agent.cmd',
      'agent.exe',
      'agent.ps1'
    ]
  }
  return WINDOWS_AGENT_BIN_NAMES
}

function whereCommand(command: string, env: StringEnv): string[] {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  try {
    const output = spawnSync(finder, [command], {
      encoding: 'utf8',
      env: withProcessEnv(env),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return (output.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function existingDirectoryFor(path: string): string | null {
  const clean = cleanCommand(path)
  try {
    if (existsSync(clean)) {
      const stat = statSync(clean)
      return normalize(stat.isDirectory() ? clean : dirname(clean))
    }
  } catch {
    return null
  }

  if (!hasPathSeparator(clean)) return null
  const parent = dirname(clean)
  return existsSync(parent) ? normalize(parent) : null
}

function pathEnvKey(env: StringEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
}

function pathContains(pathValue: string, dir: string): boolean {
  const normalized = normalize(dir)
  return pathValue
    .split(delimiter)
    .filter(Boolean)
    .some((entry) => normalize(entry).toLowerCase() === normalized.toLowerCase())
}

export function resolveCursorAgentCommand(
  env: StringEnv = processHostEnvironmentSource.snapshot()
): string {
  try {
    const { resolveProviderExecutable } = nodeRequire(
      '../../providers/executable.ts'
    ) as typeof import('../../providers/executable')
    const resolved = resolveProviderExecutable('cursorcli', { env })
    if (resolved?.command) return resolved.command
  } catch {
    // Fall through.
  }
  return 'agent'
}

export function resolveCursorAgentExecutable(
  command?: string,
  env: StringEnv = processHostEnvironmentSource.snapshot()
): string {
  const trimmed = cleanCommand(command ?? resolveCursorAgentCommand(env))
  if (process.platform !== 'win32' || hasPathSeparator(trimmed)) return trimmed

  for (const candidate of whereCommand(trimmed, env)) {
    if (existsSync(candidate)) return candidate
  }

  for (const dir of resolveKnownCursorAgentDirs(env)) {
    for (const name of commandCandidates(trimmed)) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }

  return trimmed
}

export function withCursorAgentPath(
  env: Record<string, string>,
  executable: string
): Record<string, string> {
  const dir = existingDirectoryFor(executable)
  if (!dir) return env

  const next = { ...env }
  const key = pathEnvKey(next)
  const current = next[key] ?? ''
  if (!pathContains(current, dir)) {
    next[key] = current ? `${dir}${delimiter}${current}` : dir
  }
  return next
}

export function prepareCursorAgentProcess(
  command: string,
  env: Record<string, string>
): { executable: string; env: Record<string, string> } {
  const executable = resolveCursorAgentExecutable(command, env)
  return {
    executable,
    env: withCursorAgentPath(env, executable)
  }
}

export function spawnCursorAgent(
  command: string,
  args: string[],
  options: SpawnOptions & { env: Record<string, string> }
): ChildProcess {
  const prepared = prepareCursorAgentProcess(command, options.env)
  const { cwd, env: _env, shell: _shell, ...rest } = options
  return spawnProviderInvocation({ executable: prepared.executable, prefixArgs: [] }, args, {
    ...rest,
    cwd: typeof cwd === 'string' ? cwd : process.cwd(),
    env: prepared.env
  })
}

/**
 * Spawn using a driver-discovered installation invocation (Windows `.cmd` / `.ps1` safe).
 * `pathForEnv` is the agent binary path used only to enrich PATH, not necessarily the spawn argv0.
 */
export function spawnCursorAgentInvocation(
  launch: {
    executable: string
    prefixArgs?: readonly string[] | undefined
    pathForEnv?: string | undefined
  },
  args: readonly string[],
  options: SpawnOptions & { env: Record<string, string> }
): ChildProcess {
  const env = withCursorAgentPath(options.env, launch.pathForEnv?.trim() || launch.executable)
  const { cwd, env: _env, shell: _shell, ...rest } = options
  return spawnProviderInvocation(
    {
      executable: launch.executable,
      prefixArgs: launch.prefixArgs ?? []
    },
    args,
    {
      ...rest,
      cwd: typeof cwd === 'string' ? cwd : process.cwd(),
      env
    }
  )
}

export function spawnCursorAgentSync(
  command: string,
  args: string[],
  options: SpawnSyncOptions & { env?: Record<string, string>; encoding: BufferEncoding }
): ReturnType<typeof spawnSync> {
  const baseEnv = options.env ?? (withProcessEnv() as Record<string, string>)
  const prepared = prepareCursorAgentProcess(command, baseEnv)
  const { cwd, env: _env, shell: _shell, encoding: _encoding, ...rest } = options
  return spawnProviderCommandSync({ executable: prepared.executable, prefixArgs: [] }, args, {
    ...rest,
    cwd: typeof cwd === 'string' ? cwd : process.cwd(),
    env: prepared.env
  })
}
