import type { PlannerMcpSession } from './session.ts'

export function plannerSessionTouchedStructuredPlan(
  session: Pick<PlannerMcpSession, 'planOutline' | 'taskContexts'>
): boolean {
  return Boolean(session.planOutline) || session.taskContexts.size > 0
}

export class PlannerSilentEmptyTurnError extends Error {
  readonly code = 'turn.incomplete' as const
  readonly detail: string

  constructor(
    detail = 'Planner turn ended without calling any plan MCP tools (provider may have disconnected before structured planning began)'
  ) {
    super(detail)
    this.name = 'PlannerSilentEmptyTurnError'
    this.detail = detail
  }
}

export class PlannerMissingFinalizeError extends Error {
  readonly code = 'draft.plan_not_ready' as const
  readonly detail: string

  constructor(detail = 'Planner did not finalize the structured plan via finalize_plan') {
    super(detail)
    this.name = 'PlannerMissingFinalizeError'
    this.detail = detail
  }
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
    return new PlannerSilentEmptyTurnError()
  }
  return new PlannerMissingFinalizeError()
}

export function isPlannerSilentEmptyTurnError(error: unknown): boolean {
  return (
    error instanceof PlannerSilentEmptyTurnError ||
    (error instanceof Error &&
      'code' in error &&
      (error as { code?: string }).code === 'turn.incomplete' &&
      Boolean(error.message.includes('without calling any plan MCP tools')))
  )
}
