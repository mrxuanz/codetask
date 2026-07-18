import { eq, and, isNull, sql, desc, type SQL } from 'drizzle-orm'
import type {
  JobRepository,
  ActorContext,
  JobAggregateView,
  JobDetailView,
  ListOwnedJobsInput,
  JobCasInput,
  JobCasResult,
  InsertFailureInput,
  WorkerFence,
  WorkerFenceResult,
  WorkerFenceAssertion
} from '../../../application/ports/job-repository'
import type { JobState } from '@shared/contracts/control-plane'
import type { ControlPlaneDatabase, DbExecutor } from './db-executor'
import {
  controlJobs,
  controlJobRuns,
  controlJobFailures
} from './schema'
import { parseJobState, parseControlIntent, parseResumeTarget } from './parsers'
import { projects, threads } from '../../../db/schema'
import { SqliteRunRepository } from './sqlite-run-repository'
import type { ActiveRunSummary } from '../../../domain/jobs/job-invariants'

const MAX_LIST_LIMIT = 100
const DEFAULT_LIST_LIMIT = 50

function legacyStatusToStates(status: string): readonly JobState[] | null {
  switch (status) {
    case 'pending':
      return ['planning_queued', 'execution_queued']
    case 'planning':
      return ['planning_running']
    case 'plan_ready':
    case 'plan_editing':
    case 'plan_confirmed':
      return ['plan_review']
    case 'running':
      return ['execution_running']
    case 'pausing':
      return ['pausing']
    case 'paused':
      return ['paused']
    case 'completed':
      return ['succeeded']
    case 'failed':
      return ['failed']
    case 'cancelled':
      return ['cancelled']
    default:
      return null
  }
}

const jobFieldsSelection = {
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
  lastFailureId: controlJobs.lastFailureId,
  draftMessageId: controlJobs.draftMessageId,
  title: controlJobs.title,
  requirementsSummary: controlJobs.requirementsSummary,
  createdAtMs: controlJobs.createdAtMs,
  updatedAtMs: controlJobs.updatedAtMs,
  terminalAtMs: controlJobs.terminalAtMs
}

function selectJobFields(): typeof jobFieldsSelection {
  return jobFieldsSelection
}

type JobSelectRow = {
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
  draftMessageId: string
  title: string
  requirementsSummary: string
  createdAtMs: number
  updatedAtMs: number
  terminalAtMs: number | null
}

export type { ControlPlaneDatabase } from './db-executor'

function ownerVisibilityPredicate(actor: ActorContext): SQL {
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

function toDetail(row: JobSelectRow): JobDetailView {
  return {
    ...toAggregate(row),
    draftMessageId: row.draftMessageId,
    title: row.title,
    requirementsSummary: row.requirementsSummary,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
    terminalAtMs: row.terminalAtMs
  }
}

function buildOwnedJobPredicates(input: {
  readonly actor: ActorContext
  readonly projectId?: string
  readonly status?: string
  readonly q?: string
}): SQL[] {
  const predicates: SQL[] = []
  if (input.projectId !== undefined) {
    predicates.push(eq(controlJobs.projectId, input.projectId))
  }
  if (input.status !== undefined) {
    const states = legacyStatusToStates(input.status)
    if (states === null || states.length === 0) {
      predicates.push(sql`1 = 0`)
    } else {
      predicates.push(sql`${controlJobs.state} IN (${sql.join(states.map((state) => sql`${state}`), sql`, `)})`)
    }
  }
  if (input.q !== undefined && input.q.trim().length > 0) {
    const pattern = `%${input.q.trim()}%`
    predicates.push(
      sql`(${controlJobs.title} LIKE ${pattern} OR ${controlJobs.requirementsSummary} LIKE ${pattern})`
    )
  }
  const ownership = ownerVisibilityPredicate(input.actor)
  if (ownership !== null) {
    predicates.push(ownership)
  }
  return predicates
}

export class SqliteJobRepository implements JobRepository {
  private readonly runs: SqliteRunRepository

  constructor(private readonly db: DbExecutor) {
    this.runs = new SqliteRunRepository(db)
  }

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
      .innerJoin(
        controlJobRuns,
        and(eq(controlJobRuns.id, input.runId), eq(controlJobRuns.jobId, input.jobId))
      )
      .where(
        and(
          eq(controlJobs.id, input.jobId),
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

  getOwnedJobDetail(input: {
    readonly actor: ActorContext
    readonly jobId: string
  }): JobDetailView | null {
    const predicates = buildOwnedJobPredicates({ actor: input.actor })
    predicates.unshift(eq(controlJobs.id, input.jobId))

    const result = this.db
      .select(selectJobFields())
      .from(controlJobs)
      .where(and(...predicates))
      .get()

    return result ? toDetail(result) : null
  }

  listOwnedJobDetails(input: ListOwnedJobsInput): {
    readonly jobs: readonly JobDetailView[]
    readonly total: number
  } {
    const page =
      input.page !== undefined && Number.isSafeInteger(input.page) && input.page >= 1
        ? input.page
        : 1
    let limit =
      input.limit !== undefined && Number.isSafeInteger(input.limit) && input.limit >= 1
        ? input.limit
        : DEFAULT_LIST_LIMIT
    limit = Math.min(limit, MAX_LIST_LIMIT)
    const offset = (page - 1) * limit

    const predicates = buildOwnedJobPredicates(input)
    const whereClause = predicates.length > 0 ? and(...predicates) : undefined

    const countQuery = this.db
      .select({ count: sql<number>`count(*)` })
      .from(controlJobs)
    const countRow =
      whereClause === undefined ? countQuery.get() : countQuery.where(whereClause).get()
    const total = Number(countRow?.count ?? 0)

    const listQuery = this.db
      .select(selectJobFields())
      .from(controlJobs)
      .orderBy(desc(controlJobs.updatedAtMs))
      .limit(limit)
      .offset(offset)
    const results =
      whereClause === undefined ? listQuery.all() : listQuery.where(whereClause).all()

    return {
      jobs: results.map((row) => toDetail(row)),
      total
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

    return results.map((r) => toAggregate(r))
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

    return results.map((r) => toAggregate(r))
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

  getActiveRunSummary(runId: string): ActiveRunSummary | null {
    return this.runs.getActiveRunSummary(runId)
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
}
