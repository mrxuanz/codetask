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
  readonly resultRevision: number | null
  readonly failureId: string | null
  readonly startedAtMs: number
  readonly endedAtMs: number | null
}

export interface VerificationRepository {
  create(input: {
    readonly id: string
    readonly jobId: string
    readonly executionGeneration: number
    readonly planRevision: number
    readonly scopeType: string
    readonly scopeId: string
    readonly attemptNo: number
    readonly runId: string
    readonly fenceToken: string
    readonly startedAtMs: number
  }): void

  markPassed(
    verificationId: string,
    verdictBlobHash: string,
    resultHash: string,
    resultRevision: number,
    endedAtMs: number
  ): boolean

  markRejected(verificationId: string, failureId: string, endedAtMs: number): boolean

  getById(verificationId: string): VerificationRow | null

  getRunningForScope(input: {
    readonly jobId: string
    readonly executionGeneration: number
    readonly planRevision: number
    readonly scopeType: string
    readonly scopeId: string
  }): VerificationRow | null

  getCurrentPassedVerifications(
    jobId: string,
    generation: number,
    planRevision: number,
    scopeType: string
  ): readonly VerificationRow[]

  isMilestoneReady(
    jobId: string,
    generation: number,
    planRevision: number,
    milestoneId: string
  ): boolean

  storeVerdictBlob(verdict: unknown): string

  hasRunningVerificationForRun(runId: string): boolean
}
