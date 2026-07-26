/**
 * Process-global protected spawn gateway (R1 wrap-first).
 *
 * Claude / Cursor / OpenCode async launches must call
 * {@link spawnProtectedProviderInvocation} so RuntimeAdapter.openTurn is the
 * sole protected entry (native verify + policy + supervisor + internal spawn).
 */

import type { ChildProcess } from 'node:child_process'
import type {
  ExecutionRuntimePort,
  OpenTurnRequest
} from '../../core/application/ports/execution-runtime.ts'
import type { CommandInvocation } from '../../../shared/providers/installation.ts'
import { RuntimeAdapter } from './runtime-adapter.ts'

export class ProtectedSpawnError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'runtime.protected.not_installed'
      | 'runtime.protected.sync_unsupported'
      | 'runtime.protected.no_child'
  ) {
    super(message)
    this.name = 'ProtectedSpawnError'
  }
}

let installed: ExecutionRuntimePort | null = null

export function installProtectedRuntime(runtime: ExecutionRuntimePort): void {
  installed = runtime
}

export function uninstallProtectedRuntime(): void {
  installed = null
}

export function getProtectedRuntime(): ExecutionRuntimePort | null {
  return installed
}

export type SpawnProtectedProviderInvocationOptions = {
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly stdio?: OpenTurnRequest['stdio']
  readonly signal?: AbortSignal
  readonly jobId?: string
  readonly providerCode?: string
  readonly timeoutMs?: number
  readonly abortSignal?: AbortSignal
}

/**
 * Fail-closed protected launch: requires an installed ExecutionRuntimePort that
 * supports openTurnSync and returns a child (live RuntimeAdapter).
 */
export function spawnProtectedProviderInvocation(
  invocation: CommandInvocation,
  args: readonly string[],
  options: SpawnProtectedProviderInvocationOptions
): ChildProcess {
  const runtime = installed
  if (!runtime) {
    throw new ProtectedSpawnError(
      'Protected runtime not installed; call installProtectedRuntime at composition/bootstrap',
      'runtime.protected.not_installed'
    )
  }
  if (typeof runtime.openTurnSync !== 'function') {
    throw new ProtectedSpawnError(
      'Installed runtime does not support live protected spawn (openTurnSync)',
      'runtime.protected.sync_unsupported'
    )
  }

  const result = runtime.openTurnSync({
    jobId: options.jobId ?? 'protected-spawn',
    providerCode: options.providerCode,
    timeoutMs: options.timeoutMs,
    abortSignal: options.abortSignal ?? options.signal,
    invocation: {
      executable: invocation.executable,
      prefixArgs: invocation.prefixArgs
    },
    args,
    cwd: options.cwd,
    env: options.env,
    ...(options.stdio !== undefined ? { stdio: options.stdio } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {})
  })

  if (!result.child) {
    throw new ProtectedSpawnError(
      'Protected openTurn did not return a child (dry-run-only runtime?)',
      'runtime.protected.no_child'
    )
  }

  return result.child as ChildProcess
}

/**
 * Install a live (dryRun:false) RuntimeAdapter with an injected native stub.
 * For diagnose / probe scripts that spawn providers outside full bootstrap.
 * Production boots via createApplicationForDataDir (real .node load).
 */
export function installLiveProtectedRuntimeStub(options?: {
  readonly cwd?: string
  readonly runtimeRoot?: string
  readonly providerCode?: string
}): RuntimeAdapter {
  const cwd = options?.cwd ?? process.cwd()
  const runtimeRoot = options?.runtimeRoot ?? cwd
  const adapter = new RuntimeAdapter({
    dryRun: false,
    native: {
      addonDir: '/virtual',
      nodePath: '/virtual/codeteam-sandbox.node',
      sha256: 'protected-spawn-stub',
      modulesAbi: process.versions.modules,
      binding: {
        preflight() {},
        launchSandboxedWorker() {
          return {}
        }
      }
    },
    workspace: { cwd, runtimeRoot },
    providerProfile: { providerCode: options?.providerCode ?? 'probe' }
  })
  installProtectedRuntime(adapter)
  return adapter
}
