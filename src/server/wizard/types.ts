export const WIZARD_PHASE_COLLECT = 'collect' as const
export const WIZARD_PHASE_DRAFT_REVIEW = 'draft_review' as const
export const WIZARD_PHASE_PLAN_GENERATING = 'plan_generating' as const
export const WIZARD_PHASE_PLAN_EDIT = 'plan_edit' as const
export const WIZARD_PHASE_READY_TO_LAUNCH = 'ready_to_launch' as const

export const WIZARD_PHASES = [
  WIZARD_PHASE_COLLECT,
  WIZARD_PHASE_DRAFT_REVIEW,
  WIZARD_PHASE_PLAN_GENERATING,
  WIZARD_PHASE_PLAN_EDIT,
  WIZARD_PHASE_READY_TO_LAUNCH
] as const

export type WizardPhase = (typeof WIZARD_PHASES)[number]

export interface WizardHandoffPayload {
  from: WizardPhase
  to: WizardPhase
  reason?: string
  requirementsSummary?: string
  openQuestions?: string[]
  constraints?: string[]
  sourceMessageIds?: string[]
  draftMessageId?: string | null
  draftRevision?: number | null
  planId?: string | null
}

export function isWizardPhase(value: unknown): value is WizardPhase {
  return typeof value === 'string' && (WIZARD_PHASES as readonly string[]).includes(value)
}
