import { eq, and, isNull, sql } from 'drizzle-orm'
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type {
  JobRepository,
  ActorContext,
  JobAggregateView,
  JobCasInput,
  JobCasResult,
  InsertFailureInput,
  AppendOutboxInput,
  DedupLookup,
  StoredCommandResult,
  StoreDedupInput,
  WorkerFence,
  WorkerFenceResult,
  OutboxEvent,
  CreateRunInput,
  CreateSlotInput
} from '../../../application/ports/job-repository'
import type { ActiveRunSummary } from '../../../domain/jobs/job-invariants'
import {
  controlJobs,
  controlJobRuns,
  controlJobFailures,
  controlOutboxEvents,
  controlCommandDedup,
  controlResourceSlots,
  controlPlaneSchema
} from './schema'
import { parseJobState, parseControlIntent, parseResumeTarget } from './parsers'

export type ControlPlaneDatabase = BetterSQLite3Database<typeof controlPlaneSchema>
export type AppTransaction = Parameters<Parameters<ControlPlaneDatabase['transaction']>[0]>[0]
export type DbExecutor = ControlPlaneDatabase | AppTransaction

export class SqliteJobRepository implements JobRepository {
  constructor(private readonly db: DbExecutor) {}

  getOwnedAggregate(input: { readonly actor: ActorContext; readonly jobId: string }): JobAggregateView | null {
    const result = this.db
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
      .where(eq(controlJobs.id, input.jobId))
      .get()

    if (!result) return null

    return {
      id: result.id,
      threadId: result.threadId,
      projectId: result.projectId,
      state: parseJobState(result.state),
      stateRevision: result.stateRevision,
      controlIntent: parseControlIntent(result.controlIntent),
      resumeTarget: result.resumeTarget ? parseResumeTarget(result.resumeTarget) : null,
      currentPlanRevision: result.currentPlanRevision,
      executionGeneration: result.executionGeneration,
      activeRunId: result.activeRunId,
      lastFailureId: result.lastFailureId
    }
  }

  compareAndSetJob(input: JobCasInput): JobCasResult {
    const activeRunPredicate =
      input.expectedActiveRunId === null
        ? isNull(controlJobs.activeRunId)
        : eq(controlJobs.activeRunId, input.expectedActiveRunId)

    const patch: {
      state: typeof input.next.state
      controlIntent: typeof input.next.controlIntent
      resumeTarget: typeof input.next.resumeTarget
      activeRunId: typeof input.next.activeRunId
      lastFailureId: typeof input.next.lastFailureId
      terminalAtMs: typeof input.next.terminalAtMs
      stateRevision: ReturnType<typeof sql>
      updatedAtMs: number
      executionGeneration?: number
    } = {
      state: input.next.state,
      controlIntent: input.next.controlIntent,
      resumeTarget: input.next.resumeTarget,
      activeRunId: input.next.activeRunId,
      lastFailureId: input.next.lastFailureId,
      terminalAtMs: input.next.terminalAtMs,
      stateRevision: sql`${controlJobs.stateRevision} + 1`,
      updatedAtMs: Date.now()
    }
    if (input.next.executionGeneration !== undefined) {
      patch.executionGeneration = input.next.executionGeneration
    }

    const result = this.db
      .update(controlJobs)
      .set(patch)
      .where(
        and(
          eq(controlJobs.id, input.jobId),
          eq(controlJobs.stateRevision, input.expectedRevision),
          eq(controlJobs.state, input.expectedState),
          activeRunPredicate
        )
      )
      .run()

    return result.changes === 1
      ? { ok: true, newRevision: input.expectedRevision + 1 }
      : { ok: false, reason: 'revision_conflict' }
  }

  insertFailure(input: InsertFailureInput): string {
    const id = crypto.randomUUID()
    this.db
      .insert(controlJobFailures)
      .values({
        id,
        jobId: input.jobId,
        code: input.code,
        recoverability: input.recoverability,
        reason: input.reason,
        runKind: input.runKind,
        createdAtMs: Date.now()
      })
      .run()
    return id
  }

  appendOutbox(input: AppendOutboxInput): number {
    const payloadJson = JSON.stringify(input.payload)
    const result = this.db
      .insert(controlOutboxEvents)
      .values({
        topic: input.topic,
        eventType: input.eventType,
        entityId: input.entityId,
        aggregateRevision: input.aggregateRevision,
        payloadJson,
        payloadBytes: payloadJson.length,
        createdAtMs: Date.now()
      })
      .run()

    return result.lastInsertRowid as number
  }

  getUndispatchedEvents(batchSize: number): readonly OutboxEvent[] {
    return this.db
      .select({
        eventId: controlOutboxEvents.eventId,
        topic: controlOutboxEvents.topic,
        eventType: controlOutboxEvents.eventType,
        entityId: controlOutboxEvents.entityId,
        aggregateRevision: controlOutboxEvents.aggregateRevision,
        payloadJson: controlOutboxEvents.payloadJson
      })
      .from(controlOutboxEvents)
      .where(sql`${controlOutboxEvents.dispatchedAtMs} IS NULL`)
      .orderBy(controlOutboxEvents.eventId)
      .limit(batchSize)
      .all()
  }

  markDispatched(eventIds: readonly number[]): void {
    if (eventIds.length === 0) return
    const now = Date.now()
    this.db
      .update(controlOutboxEvents)
      .set({ dispatchedAtMs: now })
      .where(
        sql`${controlOutboxEvents.eventId} IN (${sql.join(eventIds.map((id) => sql`${id}`), sql`, `)})`
      )
      .run()
  }

  getDedup(input: DedupLookup): StoredCommandResult | null {
    const result = this.db
      .select({
        responseJson: controlCommandDedup.responseJson,
        responseRevision: controlCommandDedup.responseRevision,
        requestHash: controlCommandDedup.requestHash
      })
      .from(controlCommandDedup)
      .where(
        and(
          eq(controlCommandDedup.actorUsername, input.actorUsername),
          eq(controlCommandDedup.idempotencyKey, input.idempotencyKey)
        )
      )
      .get()

    return result ?? null
  }

  storeDedup(input: StoreDedupInput): void {
    const responseJson = JSON.stringify(input.response)
    this.db
      .insert(controlCommandDedup)
      .values({
        actorUsername: input.actorUsername,
        idempotencyKey: input.idempotencyKey,
        commandType: input.commandType,
        requestHash: input.requestHash,
        responseJson,
        responseRevision: input.responseRevision,
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 24 * 60 * 60 * 1000
      })
      .run()
  }

  getActiveRunSummary(runId: string): ActiveRunSummary | null {
    const result = this.db
      .select({
        id: controlJobRuns.id,
        state: controlJobRuns.state,
        fenceToken: controlJobRuns.fenceToken,
        executionGeneration: controlJobRuns.executionGeneration,
        currentRuntimeInstanceId: controlJobRuns.currentRuntimeInstanceId,
        pendingAttemptId: controlJobRuns.pendingAttemptId,
        lifecycleOperationId: controlJobRuns.lifecycleOperationId
      })
      .from(controlJobRuns)
      .where(eq(controlJobRuns.id, runId))
      .get()

    if (!result) return null

    return {
      id: result.id,
      state: result.state,
      fenceToken: result.fenceToken,
      executionGeneration: result.executionGeneration,
      currentRuntimeInstanceId: result.currentRuntimeInstanceId,
      pendingAttemptId: result.pendingAttemptId,
      lifecycleOperationId: result.lifecycleOperationId
    }
  }

  getJobsForReconciliation(): readonly JobAggregateView[] {
    const results = this.db
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
      .where(
        sql`${controlJobs.state} NOT IN ('succeeded', 'failed', 'cancelled')
            OR ${controlJobs.activeRunId} IS NOT NULL`
      )
      .all()

    return results.map((r) => ({
      id: r.id,
      threadId: r.threadId,
      projectId: r.projectId,
      state: parseJobState(r.state),
      stateRevision: r.stateRevision,
      controlIntent: parseControlIntent(r.controlIntent),
      resumeTarget: r.resumeTarget ? parseResumeTarget(r.resumeTarget) : null,
      currentPlanRevision: r.currentPlanRevision,
      executionGeneration: r.executionGeneration,
      activeRunId: r.activeRunId,
      lastFailureId: r.lastFailureId
    }))
  }

  getQueuedJobsForClaim(limit: number): readonly JobAggregateView[] {
    const results = this.db
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
      .where(
        sql`${controlJobs.state} IN ('planning_queued', 'execution_queued')
            AND ${controlJobs.controlIntent} = 'none'
            AND ${controlJobs.activeRunId} IS NULL`
      )
      .orderBy(controlJobs.createdAtMs)
      .limit(limit)
      .all()

    return results.map((r) => ({
      id: r.id,
      threadId: r.threadId,
      projectId: r.projectId,
      state: parseJobState(r.state),
      stateRevision: r.stateRevision,
      controlIntent: parseControlIntent(r.controlIntent),
      resumeTarget: r.resumeTarget ? parseResumeTarget(r.resumeTarget) : null,
      currentPlanRevision: r.currentPlanRevision,
      executionGeneration: r.executionGeneration,
      activeRunId: r.activeRunId,
      lastFailureId: r.lastFailureId
    }))
  }

  getJobTimestamps(jobId: string): { createdAtMs: number; updatedAtMs: number; terminalAtMs: number | null } | null {
    const result = this.db
      .select({
        createdAtMs: controlJobs.createdAtMs,
        updatedAtMs: controlJobs.updatedAtMs,
        terminalAtMs: controlJobs.terminalAtMs
      })
      .from(controlJobs)
      .where(eq(controlJobs.id, jobId))
      .get()

    if (!result) return null
    return {
      createdAtMs: result.createdAtMs,
      updatedAtMs: result.updatedAtMs,
      terminalAtMs: result.terminalAtMs
    }
  }

  createRun(input: CreateRunInput): string {
    const runId = crypto.randomUUID()
    const now = Date.now()
    this.db
      .insert(controlJobRuns)
      .values({
        id: runId,
        jobId: input.jobId,
        kind: input.kind,
        state: 'starting',
        attemptNo: 1,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration,
        startedAtMs: now
      })
      .run()
    return runId
  }

  createSlot(input: CreateSlotInput): void {
    const now = Date.now()
    this.db
      .insert(controlResourceSlots)
      .values({
        id: crypto.randomUUID(),
        jobId: input.jobId,
        runId: input.runId,
        pool: input.pool,
        state: 'active',
        createdAtMs: now
      })
      .run()
  }

  markRunState(runId: string, state: string, stopReason: string | null = null): void {
    const now = Date.now()
    const ended =
      state === 'paused' ||
      state === 'cancelled' ||
      state === 'failed' ||
      state === 'succeeded' ||
      state === 'interrupted'
    this.db
      .update(controlJobRuns)
      .set({
        state,
        stopReason: stopReason ?? null,
        endedAtMs: ended ? now : null
      })
      .where(eq(controlJobRuns.id, runId))
      .run()
  }

  workerFence(input: WorkerFence): WorkerFenceResult {
    const now = Date.now()
    const result = (this.db as ControlPlaneDatabase).all(
      sql`UPDATE control_jobs
          SET state_revision = state_revision + 1,
              updated_at_ms = ${now}
          WHERE id = ${input.jobId}
            AND state_revision = ${input.expectedRevision}
            AND active_run_id = ${input.runId}
            AND execution_generation = ${input.executionGeneration}
            AND EXISTS (
              SELECT 1 FROM control_job_runs r
              WHERE r.id = ${input.runId}
                AND r.job_id = ${input.jobId}
                AND r.fence_token = ${input.fenceToken}
                AND r.execution_generation = ${input.executionGeneration}
                AND r.state IN ('active', 'pausing')
            )
          RETURNING state_revision`
    ) as Array<{ state_revision: number }>

    if (result.length === 0) {
      // Distinguish between stale run and revision conflict by checking if the run exists
      const run = (this.db as ControlPlaneDatabase).all(
        sql`SELECT state, fence_token, execution_generation
            FROM control_job_runs
            WHERE id = ${input.runId} AND job_id = ${input.jobId}`
      ) as Array<{ state: string; fence_token: string; execution_generation: number }>

      const firstRun = run[0]
      if (run.length === 0 || firstRun === undefined || firstRun.state === 'active' || firstRun.state === 'pausing') {
        // Run doesn't exist or is active but fence/generation mismatch
        if (firstRun !== undefined && firstRun.fence_token !== input.fenceToken) {
          return { ok: false, reason: 'fence_mismatch' }
        }
        return { ok: false, reason: 'revision_conflict' }
      }
      return { ok: false, reason: 'stale_run' }
    }

    const firstResult = result[0]
    if (firstResult === undefined) return { ok: false, reason: 'revision_conflict' }
    return { ok: true, newRevision: firstResult.state_revision }
  }

  transaction<T>(fn: () => T): T {
    return (this.db as ControlPlaneDatabase).transaction(fn)
  }
}
