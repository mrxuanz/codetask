import type { JobState, ControlIntent, ResumeTarget } from '@shared/contracts/control-plane'
import type { ActiveRunSummary } from '../../domain/jobs/job-invariants'
import type { ControlPlaneTransaction } from './unit-of-work'

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

export interface AppendOutboxInput {
  readonly topic: string
  readonly eventType: string
  readonly entityId: string
  readonly aggregateRevision: number
  readonly payload: unknown
  readonly createdAtMs: number
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
  readonly createdAtMs: number
  readonly expiresAtMs: number
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

export interface OutboxEvent {
  readonly eventId: number
  readonly topic: string
  readonly eventType: string
  readonly entityId: string
  readonly aggregateRevision: number
  readonly payloadJson: string
}

export interface CreateRunInput {
  readonly id: string
  readonly jobId: string
  readonly kind: 'planning' | 'execution'
  readonly fenceToken: string
  readonly executionGeneration: number
  readonly startedAtMs: number
  readonly pendingAttemptId: string
  readonly lifecycleOperationId: string
}

export interface CreateSlotInput {
  readonly id: string
  readonly jobId: string
  readonly runId: string
  readonly pool: string
  readonly createdAtMs: number
}

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

  compareAndSetJob(input: JobCasInput): JobCasResult

  insertFailure(input: InsertFailureInput): void

  appendOutbox(input: AppendOutboxInput): number

  getUndispatchedEvents(batchSize: number): readonly OutboxEvent[]

  listOwnedOutboxEvents(input: {
    readonly actor: ActorContext
    readonly afterEventId: number
    readonly limit: number
  }): readonly OutboxEvent[]

  getOwnedOutboxLatestEventId(input: { readonly actor: ActorContext }): number

  markDispatched(input: { readonly eventIds: readonly number[]; readonly dispatchedAtMs: number }): void

  getDedup(input: DedupLookup): StoredCommandResult | null

  storeDedup(input: StoreDedupInput): void

  getActiveRunSummary(runId: string): ActiveRunSummary | null

  getJobsForReconciliation(): readonly JobAggregateView[]

  getQueuedJobsForClaim(limit: number): readonly JobAggregateView[]

  getJobTimestamps(jobId: string): { createdAtMs: number; updatedAtMs: number; terminalAtMs: number | null } | null

  createRun(input: CreateRunInput): void

  createSlot(input: CreateSlotInput): void

  releaseSlot(input: { readonly runId: string; readonly releasedAtMs: number }): void

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

  createRuntimeInstance(input: {
    readonly id: string
    readonly runId: string
    readonly ownerBootId: string
    readonly provider: string
    readonly pidOrHandleRef?: string | undefined
    readonly startedAtMs: number
  }): void

  closeRuntimeInstance(input: {
    readonly id: string
    readonly runId: string
    readonly closedAtMs: number
    readonly exitKind: string
    readonly exitCode?: number | undefined
    readonly signal?: string | undefined
  }): void

  /**
   * Atomically verify worker fence (run_id + fence_token + generation + revision)
   * and bump revision in a single SQL statement. Returns stale_run if the run
   * is no longer startable/active/pausing, revision_conflict if job revision changed,
   * or fence_mismatch if run/fence/generation don't match.
   */
  workerFence(input: WorkerFence): WorkerFenceResult

  assertWorkerFence(input: Omit<WorkerFence, 'updatedAtMs'>): WorkerFenceAssertion

  /**
   * Execute a synchronous transaction. The callback must not contain await.
   * All repository methods called within the callback will participate in the same transaction.
   */
  transaction<T>(fn: (tx: ControlPlaneTransaction) => T): T
}
