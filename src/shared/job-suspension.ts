/**
 * Structured pause / recovery provenance.
 * `paused` must not mean process death — use Run/Attempt + recovery_reason instead.
 */
export type SuspensionKind = 'user_pause' | 'human_dependency' | 'policy_hold' | null

export type JobRecoveryReason =
  | 'uncertain_provider_outcome'
  | 'restart_interrupted'
  | 'migration_ambiguous'
  | null

export interface JobSuspensionState {
  suspensionKind: SuspensionKind
  continueAfterPause: boolean
  recoveryReason: JobRecoveryReason
}

export const EMPTY_SUSPENSION: JobSuspensionState = {
  suspensionKind: null,
  continueAfterPause: false,
  recoveryReason: null
}

export function parseSuspensionKind(value: string | null | undefined): SuspensionKind {
  if (value === 'user_pause' || value === 'human_dependency' || value === 'policy_hold') {
    return value
  }
  return null
}

export function parseRecoveryReason(value: string | null | undefined): JobRecoveryReason {
  if (
    value === 'uncertain_provider_outcome' ||
    value === 'restart_interrupted' ||
    value === 'migration_ambiguous'
  ) {
    return value
  }
  return null
}
