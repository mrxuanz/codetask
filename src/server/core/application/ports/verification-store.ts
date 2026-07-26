import type { VerificationAttempt } from '../../domain/verification/types'

export interface VerificationAttemptRepo {
  get(id: string): Promise<VerificationAttempt | undefined>
  save(attempt: VerificationAttempt): Promise<void>
  listForJob(jobId: string): Promise<readonly VerificationAttempt[]>
  listForScope(
    jobId: string,
    scope: VerificationAttempt['scope'],
    scopeId: string
  ): Promise<readonly VerificationAttempt[]>
}
