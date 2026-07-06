import {
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptions
} from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join, normalize } from 'node:path'

type NodeSpawn = typeof import('node:child_process').spawn
type CrossSpawn = NodeSpawn & { sync: typeof spawnSync }
type StringEnv = Record<string, string | undefined>

const nodeRequire = createRequire(import.meta.url)
const crossSpawn = nodeRequire('cross-spawn') as CrossSpawn

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

function withProcessEnv(env: StringEnv = process.env): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') merged[key] = value
  }
  return merged
}

function resolveHostHome(env: StringEnv): string | undefined {
  return (
    envValue(env, 'CODETASK_HOST_HOME') || envValue(env, 'USERPROFILE') || envValue(env, 'HOME')
  )
}

function resolveHostLocalAppData(env: StringEnv): string | undefined {
  const explicit = envValue(env, 'CODETASK_HOST_LOCALAPPDATA') || envValue(env, 'LOCALAPPDATA')
  if (explicit) return explicit
  const home = resolveHostHome(env)
  return home ? join(home, 'AppData', 'Local') : undefined
}

function resolveKnownCursorAgentDirs(env: StringEnv): string[] {
  const override = envValue(env, 'CODETASK_CURSOR_AGENT_DIR')
  if (override) return [override]

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

export function resolveCursorAgentCommand(): string {
  return process.env.CODETASK_CURSOR_AGENT_BIN?.trim() || 'agent'
}

export function resolveCursorAgentExecutable(
  command = resolveCursorAgentCommand(),
  env: StringEnv = process.env
): string {
  const trimmed = cleanCommand(command)
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
  return crossSpawn(prepared.executable, args, {
    ...options,
    env: prepared.env,
    windowsHide: true
  }) as ChildProcess
}

export function spawnCursorAgentSync(
  command: string,
  args: string[],
  options: SpawnSyncOptions & { env?: Record<string, string>; encoding: BufferEncoding }
): ReturnType<typeof spawnSync> {
  const baseEnv = options.env ?? (withProcessEnv() as Record<string, string>)
  const prepared = prepareCursorAgentProcess(command, baseEnv)
  return crossSpawn.sync(prepared.executable, args, {
    ...options,
    env: prepared.env,
    windowsHide: true
  })
}
