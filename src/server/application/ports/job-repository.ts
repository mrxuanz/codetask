import type { AppDatabase } from '../../db'
import type { JobAggregate } from '../../domain/jobs/job-state-machine'
import type {
  JobState,
  ControlIntent,
  ResumeTarget
} from '../../../shared/contracts/control-plane/primitives'

export type AppTransaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0]
export type DbExecutor = AppDatabase | AppTransaction

export type ActorContext = {
  readonly username: string
  readonly requestId: string
}

export type WorkerFence = {
  readonly jobId: string
  readonly expectedRevision: number
  readonly runId: string
  readonly fenceToken: string
  readonly executionGeneration: number
}

export type JobCasInput = {
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
  }
}

export type JobCasResult =
  | { readonly ok: true; readonly newRevision: number }
  | { readonly ok: false; readonly reason: 'revision_conflict' | 'state_conflict' }

export type InsertFailureInput = {
  readonly jobId: string
  readonly runId: string | null
  readonly code: string
  readonly recoverability: 'recoverable' | 'non_recoverable'
  readonly reason: string
  readonly detailJson: string | null
  readonly occurredAtMs: number
}

export type AppendOutboxInput = {
  readonly topic: string
  readonly eventType: string
  readonly entityId: string
  readonly aggregateRevision: number
  readonly payloadJson: string
  readonly payloadBytes: number
  readonly createdAtMs: number
}

export type DedupLookup = {
  readonly actorUsername: string
  readonly idempotencyKey: string
}

export type StoredCommandResult = {
  readonly commandType: string
  readonly requestHash: string
  readonly responseJson: string
  readonly responseRevision: number
}

export type StoreDedupInput = {
  readonly actorUsername: string
  readonly idempotencyKey: string
  readonly commandType: string
  readonly requestHash: string
  readonly responseJson: string
  readonly responseRevision: number
  readonly createdAtMs: number
  readonly expiresAtMs: number
}

export interface JobRepository {
  getOwnedAggregate(
    input: { readonly actor: ActorContext; readonly jobId: string },
    tx: DbExecutor
  ): JobAggregate | null

  compareAndSetJob(tx: DbExecutor, input: JobCasInput): JobCasResult

  insertFailure(tx: DbExecutor, input: InsertFailureInput): string

  appendOutbox(tx: DbExecutor, input: AppendOutboxInput): number

  getDedup(tx: DbExecutor, input: DedupLookup): StoredCommandResult | null

  storeDedup(tx: DbExecutor, input: StoreDedupInput): void
}
