export const DESIGN_SESSION_WORKSPACE_STATUSES = [
  'planning',
  'plan_editing',
  'cancelled',
  'failed'
] as const

export type DesignSessionWorkspaceStatus = (typeof DESIGN_SESSION_WORKSPACE_STATUSES)[number]

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

export function isDesignSessionId(id: string | null | undefined): boolean {
  return Boolean(id?.startsWith(DESIGN_SESSION_ID_PREFIX))
}

export function isDesignSessionPhase(value: unknown): value is DesignSessionPhase {
  return typeof value === 'string' && (DESIGN_SESSION_PHASES as readonly string[]).includes(value)
}
