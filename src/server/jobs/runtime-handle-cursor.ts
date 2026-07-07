import { waitForCursorScopeIdle } from '../agent-runtime/cursor-acp/runtime-registry'
import { closeCursorRuntimeScope } from '../agent-runtime/cursor-acp/stream-session-turn'
import type { RuntimeHandle } from './runtime-supervisor'

export function buildCursorPlannerRuntimeHandle(scopeId: string): RuntimeHandle {
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
      await waitForCursorScopeIdle(scopeId, { timeoutMs: 10_000 })
    }
  }
}
