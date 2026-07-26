import { waitForCursorScopeIdle } from '../agent-runtime/cursor-acp/runtime-registry'
import { closeCursorRuntimeScope } from '../agent-runtime/cursor-acp/stream-session-turn'
import {
  cancelJobSandboxTurns,
  forceTerminateJobSandboxTurns,
  waitForJobSandboxTurnsIdle
} from '../sandbox/orchestrator'
import type { RuntimeHandle } from './runtime-supervisor'

function buildCursorRuntimeHandle(scopeId: string): RuntimeHandle {
  return {
    kind: 'cursor-acp',
    cancel: async () => {
      await closeCursorRuntimeScope(scopeId)
    },
    close: async () => {
      await closeCursorRuntimeScope(scopeId)
    },
    kill: async () => {
      await closeCursorRuntimeScope(scopeId)
    },
    waitClosed: async () => {
      await closeCursorRuntimeScope(scopeId)
      await waitForCursorScopeIdle(scopeId, { timeoutMs: 15_000, pollMs: 50 })
    }
  }
}

export function buildCursorPlannerRuntimeHandle(scopeId: string): RuntimeHandle {
  return {
    kind: 'sandbox-worker',
    cancel: async () => {
      cancelJobSandboxTurns(scopeId)
    },
    close: async () => {
      cancelJobSandboxTurns(scopeId)
      await waitForJobSandboxTurnsIdle(scopeId)
      await closeCursorRuntimeScope(scopeId)
    },
    kill: async () => {
      await forceTerminateJobSandboxTurns(scopeId)
      await closeCursorRuntimeScope(scopeId)
    },
    waitClosed: async () => {
      await waitForJobSandboxTurnsIdle(scopeId)
      await waitForCursorScopeIdle(scopeId, { timeoutMs: 15_000, pollMs: 50 })
    }
  }
}

export function buildCursorJobRuntimeHandle(jobId: string): RuntimeHandle {
  return buildCursorRuntimeHandle(jobId)
}
