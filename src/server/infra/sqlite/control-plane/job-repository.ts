import { and, eq, isNull, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type {
  JobState,
  ControlIntent,
  ResumeTarget
} from '../../../../shared/contracts/control-plane/primitives'
import type {
  JobRepository,
  JobCasInput,
  JobCasResult,
  InsertFailureInput,
  AppendOutboxInput,
  DedupLookup,
  StoredCommandResult,
  StoreDedupInput,
  WorkerFence,
  DbExecutor
} from '../../../application/ports/job-repository'
import type { JobAggregate } from '../../../domain/jobs/job-state-machine'
import type { Clock } from '../../../application/ports/clock'
import type { IdGenerator } from '../../../application/ports/id-generator'
import { controlJobs, controlJobRuns, controlJobFailures, controlOutboxEvents, controlCommandDedup } from './schema'
import { projects } from '../../../db/schema'

// ─── TypeBox-compatible schema validators ───────────────────────────────────

type ErrorObject = { readonly keyword: string; readonly instancePath: string; readonly message?: string }

class ContractValidationError extends Error {
  constructor(readonly issues: readonly ErrorObject[]) {
    super('contract validation failed')
  }
}

function createParser<T>(validate: (input: unknown) => boolean, name: string): (input: unknown) => T {
  return (input: unknown): T => {
    if (validate(input)) return input as T
    throw new ContractValidationError([{ keyword: 'type', instancePath: '', message: `${name} validation failed` }])
  }
}

function isJobAggregateRow(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false
  const r = input as Record<string, unknown>
  return (
    typeof r.id === 'string' &&
    typeof r.threadId === 'string' &&
    typeof r.projectId === 'string' &&
    typeof r.state === 'string' &&
    typeof r.stateRevision === 'number' &&
    typeof r.controlIntent === 'string' &&
    (r.resumeTarget === null || typeof r.resumeTarget === 'string') &&
    (r.currentPlanRevision === null || typeof r.currentPlanRevision === 'number') &&
    typeof r.executionGeneration === 'number' &&
    (r.activeRunId === null || typeof r.activeRunId === 'string') &&
    (r.lastFailureId === null || typeof r.lastFailureId === 'string')
  )
}

function isDedupRow(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false
  const r = input as Record<string, unknown>
  return (
    typeof r.commandType === 'string' &&
    typeof r.requestHash === 'string' &&
    typeof r.responseJson === 'string' &&
    typeof r.responseRevision === 'number'
  )
}

const parseJobAggregateRow = createParser<{
  readonly id: string
  readonly threadId: string
  readonly projectId: string
  readonly state: string
  readonly stateRevision: number
  readonly controlIntent: string
  readonly resumeTarget: string | null
  readonly currentPlanRevision: number | null
  readonly executionGeneration: number
  readonly activeRunId: string | null
  readonly lastFailureId: string | null
}>(isJobAggregateRow, 'JobAggregateRow')

const parseDedupRow = createParser<{
  readonly commandType: string
  readonly requestHash: string
  readonly responseJson: string
  readonly responseRevision: number
}>(isDedupRow, 'DedupRow')

// ─── Helpers ────────────────────────────────────────────────────────────────

function activeRunPredicate(runId: string | null): SQL {
  return runId === null
    ? isNull(controlJobs.activeRunId)
    : eq(controlJobs.activeRunId, runId)
}

// ─── Repository ─────────────────────────────────────────────────────────────

export class SqliteJobRepository implements JobRepository {
  constructor(
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator
  ) {}

  getOwnedAggregate(
    input: { readonly actor: { readonly username: string; readonly requestId: string }; readonly jobId: string },
    tx: DbExecutor
  ): JobAggregate | null {
    const rows = tx
      .select({
        id: controlJobs.id,
        threadId: controlJobs.threadId,
        projectId: controlJobs.projectId,
        state: controlJobs.state,
        stateRevision: controlJobs.stateRevision,
        controlIntent: controlJobs.controlIntent,
        resumeTarget: controlJobs.resumeTarget,
        currentPlanRevision: controlJobs.currentPlanRevision,
        executionGeneration: controlJobs.executionGeneration,
        activeRunId: controlJobs.activeRunId,
        lastFailureId: controlJobs.lastFailureId
      })
      .from(controlJobs)
      .innerJoin(projects, sql`${controlJobs.projectId} = ${projects.id}`)
      .where(
        and(
          eq(controlJobs.id, input.jobId),
          eq(projects.username, input.actor.username)
        )
      )
      .limit(1)
      .all()

    if (rows.length === 0) return null

    const raw = rows[0] as unknown
    const parsed = parseJobAggregateRow(raw)

    return {
      id: parsed.id,
      threadId: parsed.threadId,
      projectId: parsed.projectId,
      state: parsed.state as JobState,
      stateRevision: parsed.stateRevision,
      controlIntent: parsed.controlIntent as ControlIntent,
      resumeTarget: parsed.resumeTarget as ResumeTarget | null,
      currentPlanRevision: parsed.currentPlanRevision,
      executionGeneration: parsed.executionGeneration,
      activeRunId: parsed.activeRunId,
      lastFailureId: parsed.lastFailureId
    }
  }

  compareAndSetJob(tx: DbExecutor, input: JobCasInput): JobCasResult {
    const now = this.clock.nowMs()

    const result = tx
      .update(controlJobs)
      .set({
        state: input.next.state,
        controlIntent: input.next.controlIntent,
        resumeTarget: input.next.resumeTarget,
        activeRunId: input.next.activeRunId,
        lastFailureId: input.next.lastFailureId,
        terminalAtMs: input.next.terminalAtMs,
        stateRevision: sql`${controlJobs.stateRevision} + 1`,
        updatedAtMs: now
      })
      .where(
        and(
          eq(controlJobs.id, input.jobId),
          eq(controlJobs.stateRevision, input.expectedRevision),
          eq(controlJobs.state, input.expectedState),
          activeRunPredicate(input.expectedActiveRunId)
        )
      )
      .run()

    return result.changes === 1
      ? { ok: true, newRevision: input.expectedRevision + 1 }
      : { ok: false, reason: 'revision_conflict' }
  }

  fenceWorker(tx: DbExecutor, input: WorkerFence): boolean {
    const now = this.clock.nowMs()

    const result = tx
      .update(controlJobs)
      .set({
        stateRevision: sql`${controlJobs.stateRevision} + 1`,
        updatedAtMs: now
      })
      .where(
        sql`${controlJobs.id} = ${sql.param(input.jobId)}
          AND ${controlJobs.stateRevision} = ${sql.param(input.expectedRevision)}
          AND ${controlJobs.activeRunId} = ${sql.param(input.runId)}
          AND ${controlJobs.executionGeneration} = ${sql.param(input.executionGeneration)}
          AND EXISTS (
            SELECT 1 FROM ${controlJobRuns} AS r
            WHERE r.id = ${sql.param(input.runId)}
              AND r.job_id = ${sql.param(input.jobId)}
              AND r.fence_token = ${sql.param(input.fenceToken)}
              AND r.execution_generation = ${sql.param(input.executionGeneration)}
              AND r.state IN ('active', 'pausing')
          )`
      )
      .run()

    return result.changes === 1
  }

  insertFailure(tx: DbExecutor, input: InsertFailureInput): string {
    const failureId = this.idGenerator.newId()

    tx.insert(controlJobFailures)
      .values({
        id: failureId,
        jobId: input.jobId,
        runId: input.runId,
        code: input.code,
        recoverability: input.recoverability,
        reason: input.reason,
        createdAtMs: input.occurredAtMs
      })
      .run()

    return failureId
  }

  appendOutbox(tx: DbExecutor, input: AppendOutboxInput): number {
    const result = tx
      .insert(controlOutboxEvents)
      .values({
        topic: input.topic,
        eventType: input.eventType,
        entityId: input.entityId,
        aggregateRevision: input.aggregateRevision,
        payloadJson: input.payloadJson,
        payloadBytes: input.payloadBytes,
        createdAtMs: input.createdAtMs
      })
      .run()

    return Number(result.lastInsertRowid)
  }

  getDedup(tx: DbExecutor, input: DedupLookup): StoredCommandResult | null {
    const rows = tx
      .select({
        commandType: controlCommandDedup.commandType,
        requestHash: controlCommandDedup.requestHash,
        responseJson: controlCommandDedup.responseJson,
        responseRevision: controlCommandDedup.responseRevision
      })
      .from(controlCommandDedup)
      .where(
        and(
          eq(controlCommandDedup.actorUsername, input.actorUsername),
          eq(controlCommandDedup.idempotencyKey, input.idempotencyKey)
        )
      )
      .limit(1)
      .all()

    if (rows.length === 0) return null

    const raw = rows[0] as unknown
    return parseDedupRow(raw)
  }

  storeDedup(tx: DbExecutor, input: StoreDedupInput): void {
    tx.insert(controlCommandDedup)
      .values({
        actorUsername: input.actorUsername,
        idempotencyKey: input.idempotencyKey,
        commandType: input.commandType,
        requestHash: input.requestHash,
        responseJson: input.responseJson,
        responseRevision: input.responseRevision,
        createdAtMs: input.createdAtMs,
        expiresAtMs: input.expiresAtMs
      })
      .run()
  }
}
