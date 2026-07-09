import type { AgentTurnOptions } from './types'
import type { ConversationRole } from './roles'
import { getExecutionRunContext } from '../jobs/execution-run-context'
import { refreshWorkloadLease } from '../jobs/workload-slot-store'
import { ProgressGuard } from './progress-guard'
import { TurnScope } from './turn-scope'

export interface ProviderTurnContext {
  signal?: AbortSignal
  onSoftCancel?: () => void
  onHardCancel?: () => void
  processExit?: Promise<never>
}

export function createProviderTurnScope(
  role: ConversationRole,
  options: AgentTurnOptions | undefined,
  ctx: ProviderTurnContext
): TurnScope {
  const turnScope = new TurnScope({
    role,
    externalSignal: options?.signal,
    processExit: ctx.processExit,
    progressGuard: new ProgressGuard(role),
    onKeepAlive: () => {
      const ectx = getExecutionRunContext()
      if (ectx?.runId) {
        void refreshWorkloadLease(ectx.runId)
      }
    },
    onCancel: async (mode) => {
      if (mode === 'soft') {
        ctx.onSoftCancel?.()
      } else {
        ctx.onHardCancel?.()
      }
    }
  })
  turnScope.arm()
  return turnScope
}

export function setupAbortController(
  signal: AbortSignal | undefined,
  onAbort: () => void
): AbortController {
  const controller = new AbortController()
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  return controller
}
