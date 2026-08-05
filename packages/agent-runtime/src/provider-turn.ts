import { TURN_CANCELLED } from '@codetask/contracts/turn-errors'
import type { AgentTurnOptions } from './types.ts'
import type { ConversationRole } from './roles.ts'
import { ProgressGuard, DEFAULT_TURN_CONFIG, type TurnConfig } from './progress-guard.ts'
import { TurnScope } from './turn-scope.ts'

export interface ProviderTurnContext {
  processExit?: Promise<never>
}

export type WorkspaceLeaseKeepAlive = () => Promise<void>

let turnConfigProvider: () => TurnConfig = () => DEFAULT_TURN_CONFIG
let keepAliveProvider: () => WorkspaceLeaseKeepAlive | null = () => null

/** Host wires app turn config + optional workspace lease refresh. */
export function configureProviderTurn(options: {
  getTurnConfig?: () => TurnConfig
  getKeepAlive?: () => WorkspaceLeaseKeepAlive | null
}): void {
  if (options.getTurnConfig) turnConfigProvider = options.getTurnConfig
  if (options.getKeepAlive) keepAliveProvider = options.getKeepAlive
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
  ctx: ProviderTurnContext
): TurnScope {
  const turnConfig = turnConfigProvider()
  const onKeepAlive = keepAliveProvider()
  const turnScope = new TurnScope({
    role,
    externalSignal: options?.signal,
    processExit: ctx.processExit,
    noFirstSignalMs: turnConfig.noFirstSignalMs,
    progressGuard: new ProgressGuard(role, turnConfig),
    onKeepAlive: async () => {
      if (onKeepAlive) await onKeepAlive()
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
