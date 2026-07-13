export interface VerificationLookup {
  getById(id: string): {
    readonly id: string
    readonly jobId: string
    readonly executionGeneration: number
    readonly planRevision: number
    readonly scopeType: string
    readonly scopeId: string
    readonly attemptNo: number
    readonly state: string
    readonly runId: string | null
    readonly fenceToken: string | null
  } | null

  create(input: {
    readonly jobId: string
    readonly executionGeneration: number
    readonly planRevision: number
    readonly scopeType: string
    readonly scopeId: string
    readonly attemptNo: number
    readonly runId: string
    readonly fenceToken: string
  }): string
}

export interface VerificationImmutabilityGuard {
  canModify(verificationId: string): boolean
  supersede(
    existingVerificationId: string,
    reason: string,
    newAttemptNo: number,
    runId: string,
    fenceToken: string
  ): string | null
}

export class VerificationImmutabilityGuardImpl implements VerificationImmutabilityGuard {
  constructor(private readonly verificationRepo: VerificationLookup) {}

  canModify(verificationId: string): boolean {
    const verification = this.verificationRepo.getById(verificationId)
    if (!verification) return false
    return verification.state === 'running'
  }

  supersede(
    existingVerificationId: string,
    _reason: string,
    newAttemptNo: number,
    runId: string,
    fenceToken: string
  ): string | null {
    const existing = this.verificationRepo.getById(existingVerificationId)
    if (!existing) return null

    if (existing.state === 'superseded') return null

    const newId = this.verificationRepo.create({
      jobId: existing.jobId,
      executionGeneration: existing.executionGeneration,
      planRevision: existing.planRevision,
      scopeType: existing.scopeType,
      scopeId: existing.scopeId,
      attemptNo: newAttemptNo,
      runId,
      fenceToken
    })

    return newId
  }
}
