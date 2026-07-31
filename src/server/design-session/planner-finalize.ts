import type { PlannerMcpSession } from '../planner/mcp/session'
import { createTurnError, isTurnError } from '../../shared/turn-errors.ts'

export function plannerSessionTouchedStructuredPlan(
  session: Pick<PlannerMcpSession, 'planOutline' | 'taskContexts'>
): boolean {
  return Boolean(session.planOutline) || session.taskContexts.size > 0
}

/**
 * Empty MCP activity after a "successful" agent turn usually means the provider
 * dropped before structured planning began — retryable. Partial MCP without
 * finalize_plan is a real planner contract failure.
 */
export function resolvePlannerMissingFinalizeError(
  session: Pick<PlannerMcpSession, 'planOutline' | 'taskContexts' | 'finalizerError'>
): Error {
  if (session.finalizerError) return session.finalizerError
  if (!plannerSessionTouchedStructuredPlan(session)) {
    return createTurnError('turn.incomplete', {
      detail:
        'Planner turn ended without calling any plan MCP tools (provider may have disconnected before structured planning began)'
    })
  }
  return createTurnError('draft.plan_not_ready', {
    detail: 'Planner did not finalize the structured plan via finalize_plan'
  })
}

export function isPlannerSilentEmptyTurnError(error: unknown): boolean {
  return (
    isTurnError(error) &&
    error.code === 'turn.incomplete' &&
    Boolean(error.detail?.includes('without calling any plan MCP tools'))
  )
}
