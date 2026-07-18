import type { JobState, ControlIntent, ResumeTarget } from '@shared/contracts/control-plane'
import type { ActiveRunSummary } from '../../domain/jobs/job-invariants'

export interface ActorContext {
  readonly username: string
  readonly requestId: string
}

export interface JobAggregateView {
  readonly id: string
  readonly threadId: string
  readonly projectId: string
  readonly state: JobState
  readonly stateRevision: number
  readonly controlIntent: ControlIntent
  readonly resumeTarget: ResumeTarget | null
  readonly currentPlanRevision: number | null
  readonly executionGeneration: number
  readonly activeRunId: string | null
  readonly lastFailureId: string | null
}

export interface JobDetailView extends JobAggregateView {
  readonly draftMessageId: string
  readonly title: string
  readonly requirementsSummary: string
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly terminalAtMs: number | null
}

export interface ListOwnedJobsInput {
  readonly actor: ActorContext
  readonly projectId?: string
  readonly status?: string
  readonly page?: number
  readonly limit?: number
  readonly q?: string
}

export interface JobCasInput {
  readonly jobId: string
  readonly updatedAtMs: number
  readonly expectedRevision: number
  readonly expectedState: JobState
  readonly expectedActiveRunId: string | null
  readonly next: {
    readonly state: JobState
    readonly controlIntent: ControlIntent
    readonly resumeTarget: ResumeTarget | null
    readonly activeRunId: string | null
    readonly lastFailureId: string | null
    readonly terminalAtMs: number | null
    readonly executionGeneration?: number
  }
}

export type JobCasResult =
  | { readonly ok: true; readonly newRevision: number }
  | { readonly ok: false; readonly reason: 'revision_conflict' | 'state_conflict' }

export interface InsertFailureInput {
  readonly id: string
  readonly jobId: string
  readonly code: string
  readonly recoverability: string
  readonly reason: string | null
  readonly runKind: string | null
  readonly createdAtMs: number
}

export interface WorkerFence {
  readonly jobId: string
  readonly expectedRevision: number
  readonly runId: string
  readonly fenceToken: string
  readonly executionGeneration: number
  readonly updatedAtMs: number
}

export type WorkerFenceResult =
  | { readonly ok: true; readonly newRevision: number }
  | { readonly ok: false; readonly reason: 'stale_run' | 'revision_conflict' | 'fence_mismatch' }

export type WorkerFenceAssertion =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'stale_run' | 'revision_conflict' | 'fence_mismatch' }

export interface JobRepository {
  getOwnedAggregate(input: {
    readonly actor: ActorContext
    readonly jobId: string
  }): JobAggregateView | null

  /** Internal read by id — no ownership filter (scheduler/reconciler/runtime bridge). */
  getAggregate(jobId: string): JobAggregateView | null

  getWorkerAggregate(input: {
    readonly jobId: string
    readonly runId: string
    readonly fenceToken: string
    readonly executionGeneration: number
  }): JobAggregateView | null

  listOwnedAggregates(input: {
    readonly actor: ActorContext
    readonly projectId?: string
  }): readonly JobAggregateView[]

  getOwnedJobDetail(input: {
    readonly actor: ActorContext
    readonly jobId: string
  }): JobDetailView | null

  listOwnedJobDetails(input: ListOwnedJobsInput): {
    readonly jobs: readonly JobDetailView[]
    readonly total: number
  }

  compareAndSetJob(input: JobCasInput): JobCasResult

  insertFailure(input: InsertFailureInput): void

  getJobsForReconciliation(): readonly JobAggregateView[]

  getQueuedJobsForClaim(limit: number): readonly JobAggregateView[]

  getJobTimestamps(jobId: string): { createdAtMs: number; updatedAtMs: number; terminalAtMs: number | null } | null

  getJobFailure(failureId: string): {
    code: string
    recoverability: string
    reason: string | null
  } | null

  getActiveRunSummary(runId: string): ActiveRunSummary | null

  /**
   * Atomically verify worker fence (run_id + fence_token + generation + revision)
   * and bump revision in a single SQL statement. Returns stale_run if the run
   * is no longer startable/active/pausing, revision_conflict if job revision changed,
   * or fence_mismatch if run/fence/generation don't match.
   */
  workerFence(input: WorkerFence): WorkerFenceResult

  assertWorkerFence(input: Omit<WorkerFence, 'updatedAtMs'>): WorkerFenceAssertion
}

// Re-export outbox/dedup types used by other application layers.
export type { OutboxEvent, AppendOutboxInput } from './outbox-repository'
export type { DedupLookup, StoredCommandResult, StoreDedupInput } from './dedup-repository'
