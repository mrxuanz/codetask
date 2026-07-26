import type { DomainResult } from '../shared/errors'
import { verificationError, type VerificationDomainError } from './errors'
import type {
  JobCompletionDecision,
  VerificationAttempt,
  VerificationAttemptStatus,
  VerificationResult,
  VerificationVerdict
} from './types'

export type VerificationTransition = {
  readonly nextStatus: VerificationAttemptStatus
  readonly result: VerificationResult | null
}

function notAllowed(
  status: VerificationAttemptStatus,
  command: string
): DomainResult<VerificationTransition, VerificationDomainError> {
  return {
    ok: false,
    error: verificationError('verification.action_not_allowed', undefined, {
      status,
      command
    })
  }
}

export function startVerification(
  attempt: Pick<VerificationAttempt, 'status'>
): DomainResult<VerificationTransition, VerificationDomainError> {
  if (attempt.status === 'pending') {
    return { ok: true, value: { nextStatus: 'running', result: null } }
  }
  return notAllowed(attempt.status, 'start')
}

export function completeVerification(
  attempt: Pick<VerificationAttempt, 'status'>,
  result: VerificationResult
): DomainResult<VerificationTransition, VerificationDomainError> {
  if (attempt.status !== 'running') {
    return notAllowed(attempt.status, 'complete')
  }
  return {
    ok: true,
    value: { nextStatus: 'completed', result }
  }
}

/**
 * Invariant (§5.3 / INVARIANTS §flow #7):
 * inconclusive must never map to pass or forge Job Completed.
 */
export function decideJobCompletion(verdict: VerificationVerdict): JobCompletionDecision {
  switch (verdict) {
    case 'pass':
      return { kind: 'complete' }
    case 'fail':
      return { kind: 'fail' }
    case 'inconclusive':
      return { kind: 'block_inconclusive' }
  }
}

export function canForgeJobCompleted(verdict: VerificationVerdict): boolean {
  return decideJobCompletion(verdict).kind === 'complete'
}

/**
 * Reject any attempt to treat an inconclusive (or fail) verdict as Completed.
 */
export function assertNotForgingCompleted(
  verdict: VerificationVerdict
): DomainResult<{ readonly completed: true }, VerificationDomainError> {
  if (verdict === 'pass') {
    return { ok: true, value: { completed: true } }
  }
  return {
    ok: false,
    error: verificationError(
      verdict === 'inconclusive'
        ? 'verification.inconclusive_not_pass'
        : 'verification.fail_not_completed',
      verdict === 'inconclusive'
        ? 'inconclusive verification must not forge Job Completed'
        : 'fail verification must not forge Job Completed',
      { verdict }
    )
  }
}

/**
 * Remapping an inconclusive verdict to pass is always illegal.
 */
export function remapVerdict(
  from: VerificationVerdict,
  to: VerificationVerdict
): DomainResult<VerificationVerdict, VerificationDomainError> {
  if (from === to) {
    return { ok: true, value: to }
  }
  if (from === 'inconclusive' && to === 'pass') {
    return {
      ok: false,
      error: verificationError(
        'verification.inconclusive_not_pass',
        'inconclusive must not be remapped to pass',
        { from, to }
      )
    }
  }
  return {
    ok: false,
    error: verificationError('verification.verdict_remap_forbidden', undefined, {
      from,
      to
    })
  }
}
