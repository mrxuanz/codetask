import type { AgentTurnChunk } from '../agent-runtime/types'
import { sandboxTurnDebug } from '../debug/sandbox-turn'

import { streamSandboxedTurnViaSupervisor } from './supervisor-client'

import {
  streamSandboxedConversationTurnLocal,
  type RunSandboxedTurnInput
} from './orchestrator-local'
import { closeJobCursorSandbox } from './job-cursor-pool'
import { getSandboxSupervisorManager } from './supervisor-manager'
import { SandboxError } from './types'

export type { RunSandboxedTurnInput } from './orchestrator-local'

export { isOuterSandboxEnabled } from './outer-sandbox-flag'

const activeJobTurns = new Map<string, Set<AbortController>>()

function registerJobTurn(jobId: string, controller: AbortController): void {
  const active = activeJobTurns.get(jobId) ?? new Set<AbortController>()
  active.add(controller)
  activeJobTurns.set(jobId, active)
}

function unregisterJobTurn(jobId: string, controller: AbortController): void {
  const active = activeJobTurns.get(jobId)
  if (!active) return
  active.delete(controller)
  if (active.size === 0) activeJobTurns.delete(jobId)
}

/** @internal test helper — register a turn without starting a real sandbox stream. */
export function registerJobTurnForTests(jobId: string, controller: AbortController): void {
  registerJobTurn(jobId, controller)
}

/** @internal test helper */
export function resetActiveJobTurnsForTests(): void {
  activeJobTurns.clear()
}

function abortJobTurns(jobId: string, reason: string): void {
  for (const controller of activeJobTurns.get(jobId) ?? []) {
    if (!controller.signal.aborted) {
      controller.abort(new SandboxError(reason, 'sandbox.turn.cancelled', 'orchestrator'))
    }
  }
}

export function shouldUseSandboxSupervisor(): boolean {
  if (process.env.CODETASK_SANDBOX_SUPERVISOR === '0') return false

  if (process.env.CODETASK_SANDBOX_SUPERVISOR_WORKER === '1') return false

  return true
}

export async function* streamSandboxedConversationTurn(
  input: RunSandboxedTurnInput
): AsyncGenerator<AgentTurnChunk> {
  const controller = new AbortController()
  const forwardAbort = (): void => controller.abort(input.signal?.reason)
  if (input.signal?.aborted) forwardAbort()
  else input.signal?.addEventListener('abort', forwardAbort, { once: true })

  const jobId = input.jobId?.trim() || ''
  if (jobId) registerJobTurn(jobId, controller)

  try {
    const scopedInput = { ...input, signal: controller.signal }
    if (shouldUseSandboxSupervisor()) {
      sandboxTurnDebug('orchestrator: routing via supervisor IPC', {
        role: input.role,
        coreCode: input.coreCode
      })
      yield* streamSandboxedTurnViaSupervisor(scopedInput)
      return
    }

    sandboxTurnDebug('orchestrator: routing local (supervisor disabled)', {
      role: input.role,
      coreCode: input.coreCode
    })

    yield* streamSandboxedConversationTurnLocal(scopedInput)
  } finally {
    input.signal?.removeEventListener('abort', forwardAbort)
    if (jobId) unregisterJobTurn(jobId, controller)
  }
}

export function cancelJobSandboxTurns(jobId: string): void {
  const trimmed = jobId.trim()
  if (!trimmed) return
  abortJobTurns(trimmed, `sandbox turns cancelled for ${trimmed}`)

  if (shouldUseSandboxSupervisor()) {
    try {
      getSandboxSupervisorManager().send({ type: 'cancel-job-turns', jobId: trimmed })
    } catch {
      // ignore
    }
    return
  }
}

export function hasActiveJobSandboxTurns(jobId: string): boolean {
  return (activeJobTurns.get(jobId.trim())?.size ?? 0) > 0
}

export async function waitForJobSandboxTurnsIdle(
  jobId: string,
  options: { timeoutMs?: number; pollMs?: number } = {}
): Promise<void> {
  const trimmed = jobId.trim()
  if (!trimmed) return
  const timeoutMs = options.timeoutMs ?? 15_000
  const pollMs = options.pollMs ?? 25
  const deadline = Date.now() + timeoutMs
  while (hasActiveJobSandboxTurns(trimmed)) {
    if (Date.now() >= deadline) {
      throw new SandboxError(
        `sandbox turns for ${trimmed} did not close within ${timeoutMs}ms`,
        'sandbox.supervisor.cleanup_failed',
        'orchestrator'
      )
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

export async function forceTerminateJobSandboxTurns(jobId: string): Promise<void> {
  const trimmed = jobId.trim()
  if (!trimmed) return
  cancelJobSandboxTurns(trimmed)
  try {
    await waitForJobSandboxTurnsIdle(trimmed, { timeoutMs: 5_000 })
    return
  } catch (error) {
    if (!shouldUseSandboxSupervisor()) throw error
  }

  await getSandboxSupervisorManager().recycle(`sandbox turns for ${trimmed} ignored cancellation`)
  await waitForJobSandboxTurnsIdle(trimmed, { timeoutMs: 5_000 })
}

export async function releaseJobCursorResources(jobId: string): Promise<void> {
  const trimmed = jobId.trim()
  if (!trimmed) return

  if (shouldUseSandboxSupervisor()) {
    try {
      // Do not spawn the supervisor solely to close a cursor — that leaves a
      // long-lived child process and can hang unit tests after delete drain.
      const manager = getSandboxSupervisorManager()
      if (manager.statusSnapshot().ready) {
        manager.send({ type: 'close-job-cursor', jobId: trimmed })
      }
    } catch {
      // ignore
    }
    return
  }

  await closeJobCursorSandbox(trimmed).catch(() => {})
}
