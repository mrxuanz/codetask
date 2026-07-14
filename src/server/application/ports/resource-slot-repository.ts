export interface CreateSlotInput {
  readonly id: string
  readonly jobId: string
  readonly runId: string
  readonly pool: string
  readonly createdAtMs: number
}

export interface ResourceSlotRepository {
  createSlot(input: CreateSlotInput): void

  releaseSlot(input: { readonly runId: string; readonly releasedAtMs: number }): void

  countActiveSlots(pool: string): number

  hasActiveSlotForRun(runId: string): boolean

  assertCapacityAvailable(pool: string, maxConcurrentJobs: number): void
}
