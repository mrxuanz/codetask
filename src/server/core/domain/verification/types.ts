declare const verificationAttemptIdBrand: unique symbol

export type VerificationAttemptId = string & {
  readonly [verificationAttemptIdBrand]: typeof verificationAttemptIdBrand
}

export function asVerificationAttemptId(value: string): VerificationAttemptId {
  return value as VerificationAttemptId
}

/** Structured verification verdict — never forge inconclusive into pass. */
export type VerificationVerdict = 'pass' | 'fail' | 'inconclusive'

export const VERIFICATION_VERDICTS = [
  'pass',
  'fail',
  'inconclusive'
] as const satisfies readonly VerificationVerdict[]

export type VerificationAttemptStatus = 'pending' | 'running' | 'completed'

export type VerificationScope = 'slice' | 'milestone' | 'job'

export type FindingSeverity = 'info' | 'warn' | 'error'

export interface VerificationFinding {
  readonly code: string
  readonly severity: FindingSeverity
  readonly message: string
  readonly evidenceRef?: string
}

export interface VerificationResult {
  readonly verdict: VerificationVerdict
  readonly summary: string
  readonly evidenceRefs: readonly string[]
  readonly findings: readonly VerificationFinding[]
}

export interface VerificationAttempt {
  readonly id: VerificationAttemptId
  readonly jobId: string
  readonly scope: VerificationScope
  readonly scopeId: string
  readonly status: VerificationAttemptStatus
  readonly executionGeneration: number
  readonly result: VerificationResult | null
}

/**
 * Job-level outcome derived from a verification verdict.
 * `complete` is only allowed for `pass` — never for `inconclusive`.
 */
export type JobCompletionDecision =
  | { readonly kind: 'complete' }
  | { readonly kind: 'fail' }
  | { readonly kind: 'block_inconclusive' }
