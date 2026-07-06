import type { SandboxChild } from '../../../native/codeteam-sandbox/index.d'
import { isUserTurnCancellation } from '../agent-runtime/cancel-detection'
import { pollSandboxExit } from './launcher'
import { SandboxError } from './types'

export function safePollSandboxExit(handle: SandboxChild): number | null {
  try {
    return pollSandboxExit(handle)
  } catch (error) {
    if (error instanceof SandboxError && error.code === 'sandbox.child_closed') {
      return -1
    }
    throw error
  }
}

export function throwIfSandboxTurnAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new SandboxError('sandbox turn cancelled', 'sandbox.turn.cancelled')
  }
}

export function isSandboxTurnCancelled(error: unknown): boolean {
  return isUserTurnCancellation(error)
}
