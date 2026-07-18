import type { TaskProgressDto } from './types'
import type { JobProgressCode, JobProgressParams } from '../../shared/progress-codes.ts'

export const MAX_VERIFICATION_ATTEMPTS = 3

export function verificationAttemptKey(scope: 'slice' | 'milestone', id: string): string {
  return `verification:${scope}:${id}`
}

export function verificationAttemptCount(
  progress: TaskProgressDto,
  scope: 'slice' | 'milestone',
  id: string
): number {
  return progress.verificationAttempts?.[verificationAttemptKey(scope, id)] ?? 0
}

export function lastVerificationBundleHash(
  progress: TaskProgressDto,
  scope: 'slice' | 'milestone',
  id: string
): string | undefined {
  return progress.verificationBundleHashes?.[verificationAttemptKey(scope, id)]
}

export function withVerificationAttempt(
  progress: TaskProgressDto,
  scope: 'slice' | 'milestone',
  id: string,
  attempt: number,
  bundleHash: string
): TaskProgressDto {
  const key = verificationAttemptKey(scope, id)
  return {
    ...progress,
    verificationAttempts: {
      ...(progress.verificationAttempts ?? {}),
      [key]: attempt
    },
    verificationBundleHashes: {
      ...(progress.verificationBundleHashes ?? {}),
      [key]: bundleHash
    }
  }
}

export type VerificationAttemptGuardResult =
  | { ok: true }
  | {
      ok: false
      reason: 'max-attempts' | 'unchanged-evidence'
      progressCode: JobProgressCode
      progressParams: JobProgressParams
    }

export function guardVerificationAttempt(input: {
  progress: TaskProgressDto
  scope: 'slice' | 'milestone'
  id: string
  bundleHash: string
}): VerificationAttemptGuardResult {
  const attempts = verificationAttemptCount(input.progress, input.scope, input.id)
  if (attempts >= MAX_VERIFICATION_ATTEMPTS) {
    return {
      ok: false,
      reason: 'max-attempts',
      progressCode:
        input.scope === 'slice'
          ? 'execution.slice_inconclusive_exhausted'
          : 'execution.milestone_inconclusive_exhausted',
      progressParams: { id: input.id, maxAttempts: MAX_VERIFICATION_ATTEMPTS }
    }
  }

  const previousHash = lastVerificationBundleHash(input.progress, input.scope, input.id)
  if (attempts > 0 && previousHash === input.bundleHash) {
    return {
      ok: false,
      reason: 'unchanged-evidence',
      progressCode:
        input.scope === 'slice' ? 'execution.slice_blocked' : 'execution.milestone_blocked',
      progressParams: { id: input.id }
    }
  }

  return { ok: true }
}
