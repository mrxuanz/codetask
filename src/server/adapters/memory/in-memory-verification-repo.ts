import type { VerificationAttempt } from '../../core/domain/verification/types'
import type { VerificationAttemptRepo } from '../../core/application/ports/verification-store'

export class InMemoryVerificationAttemptRepo implements VerificationAttemptRepo {
  private readonly store = new Map<string, VerificationAttempt>()

  async get(id: string): Promise<VerificationAttempt | undefined> {
    const row = this.store.get(id)
    return row ? { ...row, result: row.result ? { ...row.result } : null } : undefined
  }

  async save(attempt: VerificationAttempt): Promise<void> {
    this.store.set(attempt.id, {
      ...attempt,
      result: attempt.result
        ? {
            ...attempt.result,
            evidenceRefs: [...attempt.result.evidenceRefs],
            findings: [...attempt.result.findings]
          }
        : null
    })
  }

  async listForJob(jobId: string): Promise<readonly VerificationAttempt[]> {
    return [...this.store.values()].filter((a) => a.jobId === jobId)
  }

  async listForScope(
    jobId: string,
    scope: VerificationAttempt['scope'],
    scopeId: string
  ): Promise<readonly VerificationAttempt[]> {
    return [...this.store.values()].filter(
      (a) => a.jobId === jobId && a.scope === scope && a.scopeId === scopeId
    )
  }
}
