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

export interface JobCasInput {
  readonly jobId: string
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
  readonly jobId: string
  readonly code: string
  readonly recoverability: string
  readonly reason: string | null
  readonly runKind: string | null
}

export interface AppendOutboxInput {
  readonly topic: string
  readonly eventType: string
  readonly entityId: string
  readonly aggregateRevision: number
  readonly payload: unknown
}

export interface DedupLookup {
  readonly actorUsername: string
  readonly idempotencyKey: string
}

export interface StoredCommandResult {
  readonly responseJson: string
  readonly responseRevision: number
  readonly requestHash: string
}

export interface StoreDedupInput {
  readonly actorUsername: string
  readonly idempotencyKey: string
  readonly commandType: string
  readonly requestHash: string
  readonly response: unknown
  readonly responseRevision: number
}

export interface WorkerFence {
  readonly jobId: string
  readonly expectedRevision: number
  readonly runId: string
  readonly fenceToken: string
  readonly executionGeneration: number
}

export type WorkerFenceResult =
  | { readonly ok: true; readonly newRevision: number }
  | { readonly ok: false; readonly reason: 'stale_run' | 'revision_conflict' | 'fence_mismatch' }

export interface OutboxEvent {
  readonly eventId: number
  readonly topic: string
  readonly eventType: string
  readonly entityId: string
  readonly aggregateRevision: number
  readonly payloadJson: string
}

export interface CreateRunInput {
  readonly jobId: string
  readonly kind: 'planning' | 'execution'
  readonly fenceToken: string
  readonly executionGeneration: number
}

export interface CreateSlotInput {
  readonly jobId: string
  readonly runId: string
  readonly pool: string
}

export interface JobRepository {
  getOwnedAggregate(input: {
    readonly actor: ActorContext
    readonly jobId: string
  }): JobAggregateView | null

  listOwnedAggregates(input: {
    readonly actor: ActorContext
    readonly projectId?: string
  }): readonly JobAggregateView[]

  compareAndSetJob(input: JobCasInput): JobCasResult

  insertFailure(input: InsertFailureInput): string

  appendOutbox(input: AppendOutboxInput): number

  getUndispatchedEvents(batchSize: number): readonly OutboxEvent[]

  listOwnedOutboxEvents(input: {
    readonly actor: ActorContext
    readonly afterEventId: number
    readonly limit: number
  }): readonly OutboxEvent[]

  getOwnedOutboxLatestEventId(input: { readonly actor: ActorContext }): number

  markDispatched(eventIds: readonly number[]): void

  getDedup(input: DedupLookup): StoredCommandResult | null

  storeDedup(input: StoreDedupInput): void

  getActiveRunSummary(runId: string): ActiveRunSummary | null

  getJobsForReconciliation(): readonly JobAggregateView[]

  getQueuedJobsForClaim(limit: number): readonly JobAggregateView[]

  getJobTimestamps(jobId: string): { createdAtMs: number; updatedAtMs: number; terminalAtMs: number | null } | null

  createRun(input: CreateRunInput): string

  createSlot(input: CreateSlotInput): void

  releaseSlot(runId: string): void

  markRunState(runId: string, state: string, stopReason?: string | null): void

  /**
   * Atomically verify worker fence (run_id + fence_token + generation + revision)
   * and bump revision in a single SQL statement. Returns stale_run if the run
   * is no longer startable/active/pausing, revision_conflict if job revision changed,
   * or fence_mismatch if run/fence/generation don't match.
   */
  workerFence(input: WorkerFence): WorkerFenceResult

  /**
   * Execute a synchronous transaction. The callback must not contain await.
   * All repository methods called within the callback will participate in the same transaction.
   */
  transaction<T>(fn: () => T): T
}
