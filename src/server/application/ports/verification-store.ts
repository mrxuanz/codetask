export interface VerificationRow {
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
  readonly verdictBlobHash: string | null
  readonly resultHash: string | null
  readonly failureId: string | null
  readonly startedAtMs: number
  readonly endedAtMs: number | null
}

export interface VerificationStore {
  create(input: {
    jobId: string
    executionGeneration: number
    planRevision: number
    scopeType: string
    scopeId: string
    attemptNo: number
    runId: string
    fenceToken: string
  }): string
  markPassed(verificationId: string, verdictBlobHash: string, resultHash: string): boolean
  getById(verificationId: string): VerificationRow | null
  getCurrentPassedVerifications(
    jobId: string,
    generation: number,
    planRevision: number,
    scopeType: string
  ): readonly VerificationRow[]
}
