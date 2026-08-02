/**
 * Planning-phase status helpers for legacy thread_jobs / UI adapters.
 * Prefer Design PlanningSessionStatus from @codetask/contracts for new code.
 */

/** Planning-phase statuses shown on /plans (pre-execution). */
export const DESIGN_SESSION_WORKSPACE_STATUSES = [
  'planning',
  'plan_editing',
  'cancelled',
  'failed'
] as const

export type DesignSessionWorkspaceStatus = (typeof DESIGN_SESSION_WORKSPACE_STATUSES)[number]

/** Active planning statuses (not yet launched into the execution queue). */
export const PLANNING_JOB_STATUSES = ['planning', 'plan_editing'] as const
export type PlanningJobStatus = (typeof PLANNING_JOB_STATUSES)[number]

export function isPlanningJobStatus(status: string | null | undefined): boolean {
  return (
    typeof status === 'string' && (PLANNING_JOB_STATUSES as readonly string[]).includes(status)
  )
}

export function isPlanningWorkspaceStatus(status: string | null | undefined): boolean {
  return (
    typeof status === 'string' &&
    (DESIGN_SESSION_WORKSPACE_STATUSES as readonly string[]).includes(status)
  )
}
