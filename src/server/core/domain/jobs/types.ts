/**
 * Job lifecycle statuses for the pure domain state machine.
 * Cohesive execution-phase set (post plan confirm).
 */
export type JobStatus =
  | 'queued'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'verification'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type JobId = string & { readonly __brand: 'JobId' }

export function asJobId(id: string): JobId {
  return id as JobId
}

/**
 * Job aggregate — authoritative status is a single field + this state machine.
 * `executionGeneration` is immutable across pause/continue/cancel/complete;
 * only `retry` opens a new generation.
 */
export interface Job {
  readonly id: JobId
  readonly status: JobStatus
  readonly planRevision: number
  readonly executionGeneration: number
  readonly stateRevision: number
}

export function createJob(input: {
  readonly id: string
  readonly status?: JobStatus
  readonly planRevision?: number
  readonly executionGeneration?: number
  readonly stateRevision?: number
}): Job {
  return {
    id: asJobId(input.id),
    status: input.status ?? 'queued',
    planRevision: input.planRevision ?? 1,
    executionGeneration: input.executionGeneration ?? 1,
    stateRevision: input.stateRevision ?? 0
  }
}
