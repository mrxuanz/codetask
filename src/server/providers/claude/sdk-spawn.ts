import type { ChildProcess } from 'node:child_process'
import { extname } from 'node:path'
import type { CommandInvocation } from '../../../shared/providers/installation'
import { spawnProviderInvocation } from '../spawn'

export interface ClaudeSdkSpawnRequest {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string | undefined
  readonly env: Readonly<Record<string, string | undefined>>
  readonly signal: AbortSignal
}

/** Native SDK spawn cannot directly execute Windows command-script wrappers. */
export function requiresClaudeSdkSpawnGateway(
  invocation: CommandInvocation,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== 'win32') return false
  const extension = extname(invocation.executable).toLowerCase()
  return invocation.prefixArgs.length > 0 || extension === '.cmd' || extension === '.bat'
}

/**
 * The SDK may replace a JS entry with `node`; preserve that selected command
 * while prepending resolver-owned wrapper arguments (for example PowerShell).
 */
export function buildClaudeSdkCommandInvocation(
  installationInvocation: CommandInvocation,
  sdkCommand: string
): CommandInvocation {
  return {
    executable: sdkCommand,
    prefixArgs: installationInvocation.prefixArgs
  }
}

export function spawnClaudeSdkInvocation(
  installationInvocation: CommandInvocation,
  request: ClaudeSdkSpawnRequest
): ChildProcess {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(request.env)) {
    if (typeof value === 'string') env[key] = value
  }
  return spawnProviderInvocation(
    buildClaudeSdkCommandInvocation(installationInvocation, request.command),
    request.args,
    {
      cwd: request.cwd ?? process.cwd(),
      env,
      signal: request.signal,
      // The SDK custom-spawn interface consumes stdin/stdout but not stderr.
      // Inherit stderr so command-script failures cannot block on a full pipe.
      stdio: ['pipe', 'pipe', 'inherit']
    }
  )
}
