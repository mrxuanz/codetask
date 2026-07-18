import type { ActiveRunSummary } from '../../domain/jobs/job-invariants'

export interface CreateRunInput {
  readonly id: string
  readonly jobId: string
  readonly kind: 'planning' | 'execution'
  readonly fenceToken: string
  readonly executionGeneration: number
  readonly startedAtMs: number
}

export interface RunRepository {
  createRun(input: CreateRunInput): void

  getActiveRunSummary(runId: string): ActiveRunSummary | null

  markRunState(input: {
    readonly runId: string
    readonly state: string
    readonly stopReason?: string | null
    readonly updatedAtMs: number
  }): void

  markRunActive(input: {
    readonly runId: string
    readonly runtimeInstanceId: string
    readonly updatedAtMs: number
  }): void
}
