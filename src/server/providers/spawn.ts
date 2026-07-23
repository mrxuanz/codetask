import type {
  ChildProcess,
  SpawnOptions,
  SpawnSyncOptions,
  SpawnSyncReturns
} from 'node:child_process'
import { createRequire } from 'node:module'
import type { CommandInvocation } from '../../shared/providers/installation'
import type { LaunchSpec } from './types'

type NodeSpawn = typeof import('node:child_process').spawn
type CrossSpawn = NodeSpawn & {
  sync(
    command: string,
    args: readonly string[],
    options: SpawnSyncOptions & { encoding: BufferEncoding }
  ): SpawnSyncReturns<string>
}

const nodeRequire = createRequire(import.meta.url)
const crossSpawn = nodeRequire('cross-spawn') as CrossSpawn

export type SpawnProviderProcessOptions = Omit<SpawnOptions, 'cwd' | 'env' | 'shell'>
export type SpawnProviderInvocationOptions = Omit<SpawnOptions, 'cwd' | 'env' | 'shell'> & {
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}
export type SpawnProviderCommandSyncOptions = Omit<
  SpawnSyncOptions,
  'cwd' | 'env' | 'shell' | 'encoding'
> & {
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

/** Only child-process gateway used by Provider command launches. */
export function spawnProviderProcess(
  spec: LaunchSpec,
  options?: SpawnProviderProcessOptions
): ChildProcess {
  return spawnProviderInvocation({ executable: spec.executable, prefixArgs: [] }, spec.args, {
    ...options,
    cwd: spec.cwd,
    env: spec.env
  })
}

/**
 * Protocol adapters use this gateway when their final argv is assembled lazily
 * (for example OpenCode's ephemeral port or Cursor ACP arguments).
 */
export function spawnProviderInvocation(
  invocation: CommandInvocation,
  args: readonly string[],
  options: SpawnProviderInvocationOptions
): ChildProcess {
  return crossSpawn(invocation.executable, [...invocation.prefixArgs, ...args], {
    ...options,
    cwd: options.cwd,
    env: { ...options.env },
    shell: false,
    windowsHide: true
  }) as ChildProcess
}

/** Structured synchronous probe; cross-spawn safely handles Windows cmd shims. */
export function spawnProviderCommandSync(
  invocation: CommandInvocation,
  args: readonly string[],
  options: SpawnProviderCommandSyncOptions
): SpawnSyncReturns<string> {
  return crossSpawn.sync(invocation.executable, [...invocation.prefixArgs, ...args], {
    ...options,
    cwd: options.cwd,
    env: { ...options.env },
    shell: false,
    windowsHide: true,
    encoding: 'utf8'
  })
}
