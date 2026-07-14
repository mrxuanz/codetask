import type { AgentTurnChunk } from '../agent-runtime/types'
import { sandboxTurnDebug } from '../debug/sandbox-turn'

import { streamSandboxedTurnViaSupervisor } from './supervisor-client'

import {
  streamSandboxedConversationTurnLocal,
  type RunSandboxedTurnInput
} from './orchestrator-local'
import { closeJobCursorSandbox } from './job-cursor-pool'
import { getSandboxSupervisorManager } from './supervisor-manager'

export type { RunSandboxedTurnInput } from './orchestrator-local'

export { isOuterSandboxEnabled } from './orchestrator-local'

export function shouldUseSandboxSupervisor(): boolean {
  if (process.env.CODETASK_SANDBOX_SUPERVISOR === '0') return false

  if (process.env.CODETASK_SANDBOX_SUPERVISOR_WORKER === '1') return false

  return true
}

export async function* streamSandboxedConversationTurn(
  input: RunSandboxedTurnInput
): AsyncGenerator<AgentTurnChunk> {
  if (shouldUseSandboxSupervisor()) {
    sandboxTurnDebug('orchestrator: routing via supervisor IPC', {
      role: input.role,
      coreCode: input.coreCode
    })
    yield* streamSandboxedTurnViaSupervisor(input)
    return
  }

  sandboxTurnDebug('orchestrator: routing local (supervisor disabled)', {
    role: input.role,
    coreCode: input.coreCode
  })

  yield* streamSandboxedConversationTurnLocal(input)
}

export function cancelJobSandboxTurns(jobId: string): void {
  const trimmed = jobId.trim()
  if (!trimmed) return

  if (shouldUseSandboxSupervisor()) {
    try {
      getSandboxSupervisorManager().send({ type: 'cancel-job-turns', jobId: trimmed })
    } catch {
      // ignore
    }
    return
  }
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
