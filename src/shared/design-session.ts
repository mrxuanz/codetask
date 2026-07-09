/** Planning-phase statuses shown on /plans (pre-execution). */
export const DESIGN_SESSION_WORKSPACE_STATUSES = [
  'planning',
  'plan_editing',
  'cancelled',
  'failed'
] as const

export type DesignSessionWorkspaceStatus = (typeof DESIGN_SESSION_WORKSPACE_STATUSES)[number]

/** @deprecated Prefer isPlanningJobStatus; kept for migrated ds-* ids. */
export const DESIGN_SESSION_ID_PREFIX = 'ds-'

export const DESIGN_SESSION_PHASES = [
  'collect',
  'draft_review',
  'plan_generating',
  'plan_edit',
  'ready_to_launch',
  'archived'
] as const

export type DesignSessionPhase = (typeof DESIGN_SESSION_PHASES)[number]

export const DESIGN_RUN_KINDS = ['planner', 'wizard_edit'] as const
export type DesignRunKind = (typeof DESIGN_RUN_KINDS)[number]

export const DESIGN_RUN_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled'
] as const

export type DesignRunStatus = (typeof DESIGN_RUN_STATUSES)[number]

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

/**
 * @deprecated Route by status/phase via isPlanningJobStatus instead of id prefix.
 * Still true for migrated historical `ds-*` rows that remain in thread_jobs.
 */
export function isDesignSessionId(id: string | null | undefined): boolean {
  return Boolean(id?.startsWith(DESIGN_SESSION_ID_PREFIX))
}

export function isDesignSessionPhase(value: unknown): value is DesignSessionPhase {
  return typeof value === 'string' && (DESIGN_SESSION_PHASES as readonly string[]).includes(value)
}
