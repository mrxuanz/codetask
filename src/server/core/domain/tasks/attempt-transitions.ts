import { illegalAttemptTransition } from './errors'
import { TERMINAL_ATTEMPT_STATUSES, type TaskAttempt } from './types'

function assertNotTerminal(attempt: TaskAttempt, command: string): void {
  if (TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) {
    throw illegalAttemptTransition(attempt.status, command)
  }
}

/** pending → running. */
export function startAttempt(attempt: TaskAttempt): TaskAttempt {
  assertNotTerminal(attempt, 'startAttempt')
  if (attempt.status !== 'pending') {
    throw illegalAttemptTransition(attempt.status, 'startAttempt')
  }
  return { ...attempt, status: 'running' }
}

/** running → succeeded (terminates once). */
export function succeedAttempt(
  attempt: TaskAttempt,
  resultHash: string
): TaskAttempt {
  assertNotTerminal(attempt, 'succeedAttempt')
  if (attempt.status !== 'running') {
    throw illegalAttemptTransition(attempt.status, 'succeedAttempt')
  }
  return {
    ...attempt,
    status: 'succeeded',
    resultHash,
    errorCode: null
  }
}

/** running → failed (terminates once). */
export function failAttempt(attempt: TaskAttempt, errorCode: string): TaskAttempt {
  assertNotTerminal(attempt, 'failAttempt')
  if (attempt.status !== 'running') {
    throw illegalAttemptTransition(attempt.status, 'failAttempt')
  }
  return {
    ...attempt,
    status: 'failed',
    errorCode,
    resultHash: null
  }
}

/**
 * running → inconclusive (terminates once).
 * Inconclusive must never be forged into succeeded.
 */
export function markInconclusive(
  attempt: TaskAttempt,
  errorCode = 'provider.inconclusive'
): TaskAttempt {
  assertNotTerminal(attempt, 'markInconclusive')
  if (attempt.status !== 'running') {
    throw illegalAttemptTransition(attempt.status, 'markInconclusive')
  }
  return {
    ...attempt,
    status: 'inconclusive',
    errorCode,
    resultHash: null
  }
}
