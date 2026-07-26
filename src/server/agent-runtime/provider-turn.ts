import { TURN_CANCELLED } from '../../shared/turn-errors.ts'
import type { AgentTurnOptions } from './types'
import type { ConversationRole } from './roles'
import { ProgressGuard } from './progress-guard'
import { TurnScope } from './turn-scope'
import { DEFAULT_TURN_RUNTIME_CONFIG } from './turn-runtime-config'

export interface ProviderTurnContext {
  processExit?: Promise<never>
}

export function abortReason(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : TURN_CANCELLED
}

export function forwardAbortSignal(
  signal: AbortSignal | undefined,
  controller: AbortController
): () => void {
  const abort = (): void => controller.abort(abortReason(signal))
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  return abort
}

export function createProviderTurnScope(
  role: ConversationRole,
  options: AgentTurnOptions | undefined,
  context: ProviderTurnContext
): TurnScope {
  const turnScope = new TurnScope({
    role,
    externalSignal: options?.signal,
    processExit: context.processExit,
    noFirstSignalMs: DEFAULT_TURN_RUNTIME_CONFIG.noFirstSignalMs,
    progressGuard: new ProgressGuard(role, DEFAULT_TURN_RUNTIME_CONFIG)
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
