import { eq, and, isNull, sql, type SQL } from 'drizzle-orm'
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
  WorkerFenceAssertion,
  OutboxEvent,
  CreateRunInput,
  CreateSlotInput
} from '../../../application/ports/job-repository'
import type {
  ControlPlaneTransaction,
  ControlPlaneUnitOfWork
} from '../../../application/ports/unit-of-work'
import type { ActiveRunSummary } from '../../../domain/jobs/job-invariants'
import {
  controlJobs,
  controlJobRuns,
  controlJobFailures,
  controlOutboxEvents,
  controlCommandDedup,
  controlResourceSlots,
  controlRuntimeInstances,
  controlPlaneSchema
} from './schema'
import { parseJobState, parseControlIntent, parseResumeTarget } from './parsers'
import { projects, threads } from '../../../db/schema'

export type ControlPlaneDatabase = BetterSQLite3Database<typeof controlPlaneSchema>
export type AppTransaction = Parameters<Parameters<ControlPlaneDatabase['transaction']>[0]>[0]
export type DbExecutor = ControlPlaneDatabase | AppTransaction

function ownerVisibilityPredicate(actor: ActorContext) {
  return sql`EXISTS (
    SELECT 1
    FROM ${threads}
    INNER JOIN ${projects} ON ${projects.id} = ${threads.projectId}
    WHERE ${threads.id} = ${controlJobs.threadId}
      AND ${projects.id} = ${controlJobs.projectId}
      AND ${projects.username} = ${actor.username}
  )`
}

function toAggregate(row: {
  id: string
  threadId: string
  projectId: string
  state: string
  stateRevision: number
  controlIntent: string
  resumeTarget: string | null
  currentPlanRevision: number | null
  executionGeneration: number
  activeRunId: string | null
  lastFailureId: string | null
}): JobAggregateView {
  return {
    id: row.id,
    threadId: row.threadId,
    projectId: row.projectId,
    state: parseJobState(row.state),
    stateRevision: row.stateRevision,
    controlIntent: parseControlIntent(row.controlIntent),
    resumeTarget: row.resumeTarget ? parseResumeTarget(row.resumeTarget) : null,
    currentPlanRevision: row.currentPlanRevision,
    executionGeneration: row.executionGeneration,
    activeRunId: row.activeRunId,
    lastFailureId: row.lastFailureId
  }
}

export class SqliteJobRepository implements JobRepository, ControlPlaneUnitOfWork {
  constructor(private readonly db: DbExecutor) {}

  getOwnedAggregate(input: { readonly actor: ActorContext; readonly jobId: string }): JobAggregateView | null {
    const predicates: SQL[] = [eq(controlJobs.id, input.jobId)]
    const ownership = ownerVisibilityPredicate(input.actor)
    if (ownership !== null) {
      predicates.push(ownership)
    }

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
      .where(and(...predicates))
      .get()

    if (!result) return null

    return toAggregate(result)
  }

  getAggregate(jobId: string): JobAggregateView | null {
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
      .where(eq(controlJobs.id, jobId))
      .get()

    return result ? toAggregate(result) : null
  }

  getWorkerAggregate(input: {
    readonly jobId: string
    readonly runId: string
    readonly fenceToken: string
    readonly executionGeneration: number
  }): JobAggregateView | null {
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
      .innerJoin(controlJobRuns, eq(controlJobRuns.id, controlJobs.activeRunId))
      .where(
        and(
          eq(controlJobs.id, input.jobId),
          eq(controlJobs.activeRunId, input.runId),
          eq(controlJobs.executionGeneration, input.executionGeneration),
          eq(controlJobRuns.jobId, input.jobId),
          eq(controlJobRuns.fenceToken, input.fenceToken),
          eq(controlJobRuns.executionGeneration, input.executionGeneration)
        )
      )
      .get()

    return result ? toAggregate(result) : null
  }

  listOwnedAggregates(input: {
    readonly actor: ActorContext
    readonly projectId?: string
  }): readonly JobAggregateView[] {
    const predicates: SQL[] = []
    if (input.projectId !== undefined) {
      predicates.push(eq(controlJobs.projectId, input.projectId))
    }

    const ownership = ownerVisibilityPredicate(input.actor)
    if (ownership !== null) {
      predicates.push(ownership)
    }

    const query = this.db
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

    const results = predicates.length > 0 ? query.where(and(...predicates)).all() : query.all()
    return results.map((row) => toAggregate(row))
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
      updatedAtMs: input.updatedAtMs
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

  insertFailure(input: InsertFailureInput): void {
    this.db
      .insert(controlJobFailures)
      .values({
        id: input.id,
        jobId: input.jobId,
        code: input.code,
        recoverability: input.recoverability,
        reason: input.reason,
        runKind: input.runKind,
        createdAtMs: input.createdAtMs
      })
      .run()
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
        createdAtMs: input.createdAtMs
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

  listOwnedOutboxEvents(input: {
    readonly actor: ActorContext
    readonly afterEventId: number
    readonly limit: number
  }): readonly OutboxEvent[] {
    const predicates: SQL[] = [sql`${controlOutboxEvents.eventId} > ${input.afterEventId}`]
    predicates.push(sql`EXISTS (
      SELECT 1 FROM ${controlJobs}
      INNER JOIN ${threads} ON ${threads.id} = ${controlJobs.threadId}
      INNER JOIN ${projects} ON ${projects.id} = ${threads.projectId}
      WHERE ${controlJobs.id} = ${controlOutboxEvents.entityId}
        AND ${projects.id} = ${controlJobs.projectId}
        AND ${projects.username} = ${input.actor.username}
    )`)

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
      .where(and(...predicates))
      .orderBy(controlOutboxEvents.eventId)
      .limit(input.limit)
      .all()
  }

  getOwnedOutboxLatestEventId(input: { readonly actor: ActorContext }): number {
    const predicates: SQL[] = []
    predicates.push(sql`EXISTS (
      SELECT 1 FROM ${controlJobs}
      INNER JOIN ${threads} ON ${threads.id} = ${controlJobs.threadId}
      INNER JOIN ${projects} ON ${projects.id} = ${threads.projectId}
      WHERE ${controlJobs.id} = ${controlOutboxEvents.entityId}
        AND ${projects.id} = ${controlJobs.projectId}
        AND ${projects.username} = ${input.actor.username}
    )`)

    const query = this.db
      .select({
        eventId: sql<number>`COALESCE(MAX(${controlOutboxEvents.eventId}), 0)`
      })
      .from(controlOutboxEvents)

    const result =
      predicates.length > 0 ? query.where(and(...predicates)).get() : query.get()

    return result?.eventId ?? 0
  }

  markDispatched(input: { readonly eventIds: readonly number[]; readonly dispatchedAtMs: number }): void {
    if (input.eventIds.length === 0) return
    this.db
      .update(controlOutboxEvents)
      .set({ dispatchedAtMs: input.dispatchedAtMs })
      .where(
        sql`${controlOutboxEvents.eventId} IN (${sql.join(input.eventIds.map((id) => sql`${id}`), sql`, `)})`
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
        createdAtMs: input.createdAtMs,
        expiresAtMs: input.expiresAtMs
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

  getJobFailure(failureId: string): {
    code: string
    recoverability: string
    reason: string | null
  } | null {
    const result = this.db
      .select({
        code: controlJobFailures.code,
        recoverability: controlJobFailures.recoverability,
        reason: controlJobFailures.reason
      })
      .from(controlJobFailures)
      .where(eq(controlJobFailures.id, failureId))
      .get()

    return result ?? null
  }

  createRun(input: CreateRunInput): void {
    this.db
      .insert(controlJobRuns)
      .values({
        id: input.id,
        jobId: input.jobId,
        kind: input.kind,
        state: 'starting',
        attemptNo: 1,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration,
        pendingAttemptId: input.pendingAttemptId,
        lifecycleOperationId: input.lifecycleOperationId,
        startedAtMs: input.startedAtMs
      })
      .run()
  }

  createSlot(input: CreateSlotInput): void {
    this.db
      .insert(controlResourceSlots)
      .values({
        id: input.id,
        jobId: input.jobId,
        runId: input.runId,
        pool: input.pool,
        state: 'active',
        createdAtMs: input.createdAtMs
      })
      .run()
  }

  releaseSlot(input: { readonly runId: string; readonly releasedAtMs: number }): void {
    this.db
      .update(controlResourceSlots)
      .set({
        state: 'released',
        releasedAtMs: input.releasedAtMs
      })
      .where(
        and(eq(controlResourceSlots.runId, input.runId), sql`${controlResourceSlots.state} != 'released'`)
      )
      .run()
  }

  markRunState(input: { readonly runId: string; readonly state: string; readonly stopReason?: string | null; readonly updatedAtMs: number }): void {
    const ended =
      input.state === 'paused' ||
      input.state === 'cancelled' ||
      input.state === 'failed' ||
      input.state === 'succeeded' ||
      input.state === 'interrupted'
    this.db
      .update(controlJobRuns)
      .set({
        state: input.state,
        stopReason: input.stopReason ?? null,
        endedAtMs: ended ? input.updatedAtMs : null
      })
      .where(eq(controlJobRuns.id, input.runId))
      .run()
  }

  markRunActive(input: {
    readonly runId: string
    readonly runtimeInstanceId: string
    readonly updatedAtMs: number
  }): void {
    this.db
      .update(controlJobRuns)
      .set({
        state: 'active',
        currentRuntimeInstanceId: input.runtimeInstanceId,
        pendingAttemptId: null,
        lifecycleOperationId: null,
        heartbeatAtMs: input.updatedAtMs
      })
      .where(eq(controlJobRuns.id, input.runId))
      .run()
  }

  createRuntimeInstance(input: {
    readonly id: string
    readonly runId: string
    readonly ownerBootId: string
    readonly provider: string
    readonly pidOrHandleRef?: string
    readonly startedAtMs: number
  }): void {
    this.db
      .insert(controlRuntimeInstances)
      .values({
        id: input.id,
        runId: input.runId,
        state: 'active',
        ownerBootId: input.ownerBootId,
        provider: input.provider,
        pidOrHandleRef: input.pidOrHandleRef ?? null,
        startedAtMs: input.startedAtMs
      })
      .run()
  }

  closeRuntimeInstance(input: {
    readonly id: string
    readonly runId: string
    readonly closedAtMs: number
    readonly exitKind: string
    readonly exitCode?: number
    readonly signal?: string
  }): void {
    this.db
      .insert(controlRuntimeInstances)
      .values({
        id: input.id,
        runId: input.runId,
        state: 'closed',
        ownerBootId: 'control-plane',
        startedAtMs: input.closedAtMs,
        closedAtMs: input.closedAtMs,
        exitKind: input.exitKind,
        exitCode: input.exitCode ?? null,
        signal: input.signal ?? null
      })
      .onConflictDoUpdate({
        target: controlRuntimeInstances.id,
        set: {
          state: 'closed',
          closedAtMs: input.closedAtMs,
          exitKind: input.exitKind,
          exitCode: input.exitCode ?? null,
          signal: input.signal ?? null
        }
      })
      .run()
  }

  workerFence(input: WorkerFence): WorkerFenceResult {
    const result = (this.db as ControlPlaneDatabase).all(
      sql`UPDATE control_jobs
          SET state_revision = state_revision + 1,
              updated_at_ms = ${input.updatedAtMs}
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
                AND r.state IN ('starting', 'retrying', 'active', 'pausing')
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
      if (
        run.length === 0 ||
        firstRun === undefined ||
        firstRun.state === 'starting' ||
        firstRun.state === 'retrying' ||
        firstRun.state === 'active' ||
        firstRun.state === 'pausing'
      ) {
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

  assertWorkerFence(input: Omit<WorkerFence, 'updatedAtMs'>): WorkerFenceAssertion {
    const job = this.getWorkerAggregate(input)
    if (job === null) return { ok: false, reason: 'fence_mismatch' }
    if (job.stateRevision !== input.expectedRevision) {
      return { ok: false, reason: 'revision_conflict' }
    }
    const run = this.getActiveRunSummary(input.runId)
    if (
      run === null ||
      !['starting', 'retrying', 'active', 'pausing'].includes(run.state)
    ) {
      return { ok: false, reason: 'stale_run' }
    }
    return { ok: true }
  }

  transaction<T>(fn: (tx: ControlPlaneTransaction) => T): T {
    return (this.db as ControlPlaneDatabase).transaction((tx) =>
      fn({ jobs: new SqliteJobRepository(tx) })
    )
  }
}
