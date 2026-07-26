/**
 * Domain-shaped repository adapters implementing
 * `core/application/ports/repositories.ts` (ThreadRepo / DraftRepo / PlanRepo / JobRepo)
 * and `core/application/ports/task-projection.ts` (TaskProjectionRepo / AttemptRepo),
 * plus lease / verification / retention domain ports.
 *
 * Row-level CAS / outbox / artifact APIs remain in `./ports.ts` and `./repositories/*`.
 */

import {
  asProjectId,
  asThreadId,
  asUserId,
  type Thread
} from '../../core/domain/conversation/types'
import {
  asDraftId,
  type Draft,
  type DraftPayload,
  type DraftStatus
} from '../../core/domain/drafts/types'
import {
  asJobId,
  type Job,
  type JobStatus
} from '../../core/domain/jobs/types'
import {
  asPlanId,
  asPlanNodeId,
  asPlanRevision,
  type Plan,
  type PlanEdge,
  type PlanNode,
  type PlanNodeKind,
  type PlanStatus
} from '../../core/domain/plans/types'
import {
  asAttemptId,
  asTaskId,
  type AttemptStatus,
  type TaskAttempt
} from '../../core/domain/tasks/types'
import {
  asVerificationAttemptId,
  type VerificationAttempt,
  type VerificationAttemptStatus,
  type VerificationResult,
  type VerificationScope,
  type VerificationVerdict
} from '../../core/domain/verification/types'
import type {
  ArtifactRetentionKind,
  RetainedArtifact
} from '../../core/domain/retention/types'
import {
  RevisionConflictError,
  type DraftRepo,
  type JobRepo,
  type PlanRepo,
  type SaveOptions,
  type ThreadRepo
} from '../../core/application/ports/repositories'
import type {
  AttemptRepo,
  ProjectedTask,
  ProjectedTaskStatus,
  TaskProjectionRepo
} from '../../core/application/ports/task-projection'
import type {
  WorkspaceLease,
  WorkspaceLeaseRepo
} from '../../core/application/ports/workspace-lease'
import type { VerificationAttemptRepo } from '../../core/application/ports/verification-store'
import type { RetentionStore } from '../../core/application/ports/retention-store'
import type { CoreTaskAttemptRecord, CoreTaskRecord } from './ports'
import type { SqliteDatabase } from './migrate-core'
import { SqliteArtifactRepository } from './repositories/artifact-repository'
import { SqliteAttemptRepository } from './repositories/attempt-repository'
import { SqliteDraftRepository } from './repositories/draft-repository'
import { SqliteJobRepository } from './repositories/job-repository'
import { SqlitePlanRepository } from './repositories/plan-repository'
import { SqliteTaskRepository } from './repositories/task-repository'
import { SqliteThreadRepository } from './repositories/thread-repository'

/** Retention rows live in `core_artifacts` (not `core_retention_markers`; markers are for cleaner). */
const RETENTION_PROJECT_ID = '_retention'

type TaskProjectionPayload = {
  readonly executionGeneration?: number
  readonly sliceId?: string
  readonly milestoneId?: string
}

function parseTaskProjectionPayload(payloadJson: string): TaskProjectionPayload {
  try {
    const parsed = JSON.parse(payloadJson) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    const obj = parsed as Record<string, unknown>
    return {
      ...(typeof obj.executionGeneration === 'number'
        ? { executionGeneration: obj.executionGeneration }
        : {}),
      ...(typeof obj.sliceId === 'string' ? { sliceId: obj.sliceId } : {}),
      ...(typeof obj.milestoneId === 'string' ? { milestoneId: obj.milestoneId } : {})
    }
  } catch {
    return {}
  }
}

function parseDependencyIds(dependencyIdsJson: string): readonly string[] {
  try {
    const parsed = JSON.parse(dependencyIdsJson) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string')
  } catch {
    return []
  }
}

function toProjectedTask(row: CoreTaskRecord): ProjectedTask | undefined {
  const payload = parseTaskProjectionPayload(row.payloadJson)
  if (typeof payload.executionGeneration !== 'number') return undefined
  return {
    jobId: row.jobId,
    executionGeneration: payload.executionGeneration,
    task: {
      id: asTaskId(row.id),
      dependencyIds: parseDependencyIds(row.dependencyIdsJson).map(asTaskId),
      ...(row.title ? { title: row.title } : {})
    },
    status: row.status as ProjectedTaskStatus,
    ...(payload.sliceId !== undefined ? { sliceId: payload.sliceId } : {}),
    ...(payload.milestoneId !== undefined ? { milestoneId: payload.milestoneId } : {})
  }
}

function toTaskAttempt(row: CoreTaskAttemptRecord): TaskAttempt {
  return {
    id: asAttemptId(row.id),
    taskId: asTaskId(row.taskId),
    executionGeneration: row.executionGeneration,
    status: row.status as AttemptStatus,
    idempotencyKey: row.idempotencyKey,
    resultHash: row.resultHash,
    errorCode: row.errorCode
  }
}

export class SqliteDomainThreadRepository implements ThreadRepo {
  private readonly rows: SqliteThreadRepository

  constructor(db: SqliteDatabase) {
    this.rows = new SqliteThreadRepository(db)
  }

  async get(id: string): Promise<Thread | undefined> {
    const row = this.rows.get(id)
    if (!row) return undefined
    return {
      id: asThreadId(row.id),
      projectId: asProjectId(row.projectId),
      ownerUserId: asUserId(row.ownerUserId),
      draftId: row.draftId,
      planId: row.planId,
      jobId: row.jobId
    }
  }

  async save(thread: Thread, options?: SaveOptions): Promise<void> {
    const existing = this.rows.get(thread.id)
    const now = Date.now()
    if (options?.expectedRevision !== undefined) {
      if (!existing || existing.revision !== options.expectedRevision) {
        throw new RevisionConflictError(
          `Thread ${thread.id}: expected revision ${options.expectedRevision}, have ${existing?.revision ?? 'missing'}`
        )
      }
      const result = this.rows.compareAndSet({
        id: thread.id,
        expectedRevision: options.expectedRevision,
        next: {
          projectId: thread.projectId,
          ownerUserId: thread.ownerUserId,
          status: existing.status,
          draftId: thread.draftId,
          planId: thread.planId,
          jobId: thread.jobId,
          title: existing.title,
          payloadJson: existing.payloadJson,
          updatedAtMs: now
        }
      })
      if (!result.ok) throw new RevisionConflictError(`Thread ${thread.id}: revision conflict`)
      return
    }

    this.rows.save({
      id: thread.id,
      projectId: thread.projectId,
      ownerUserId: thread.ownerUserId,
      status: existing?.status ?? 'active',
      revision: (existing?.revision ?? 0) + (existing ? 1 : 0),
      draftId: thread.draftId,
      planId: thread.planId,
      jobId: thread.jobId,
      title: existing?.title ?? null,
      payloadJson: existing?.payloadJson ?? '{}',
      createdAtMs: existing?.createdAtMs ?? now,
      updatedAtMs: now
    })
  }
}

function serializeDraftPayload(payload: DraftPayload | undefined): string {
  return JSON.stringify(payload ?? {})
}

function parseDraftPayload(payloadJson: string): DraftPayload | undefined {
  try {
    const parsed = JSON.parse(payloadJson) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined
    }
    const record = parsed as Record<string, unknown>
    if (Object.keys(record).length === 0) return undefined
    return record as DraftPayload
  } catch {
    return undefined
  }
}

export class SqliteDomainDraftRepository implements DraftRepo {
  private readonly rows: SqliteDraftRepository

  constructor(db: SqliteDatabase) {
    this.rows = new SqliteDraftRepository(db)
  }

  async get(id: string): Promise<Draft | undefined> {
    const row = this.rows.get(id)
    if (!row) return undefined
    const payload = parseDraftPayload(row.payloadJson)
    return {
      id: asDraftId(row.id),
      status: row.status as DraftStatus,
      revision: row.revision,
      content: row.content,
      projectId: row.projectId,
      threadId: row.threadId,
      ...(payload !== undefined ? { payload } : {})
    }
  }

  async save(draft: Draft, options?: SaveOptions): Promise<void> {
    const existing = this.rows.get(draft.id)
    const now = Date.now()
    const payloadJson = serializeDraftPayload(draft.payload)
    if (options?.expectedRevision !== undefined) {
      if (!existing || existing.revision !== options.expectedRevision) {
        throw new RevisionConflictError(
          `Draft ${draft.id}: expected revision ${options.expectedRevision}, have ${existing?.revision ?? 'missing'}`
        )
      }
      const result = this.rows.compareAndSet({
        id: draft.id,
        expectedRevision: options.expectedRevision,
        next: {
          projectId: draft.projectId,
          threadId: draft.threadId,
          status: draft.status,
          content: draft.content,
          payloadJson,
          updatedAtMs: now
        }
      })
      if (!result.ok) throw new RevisionConflictError(`Draft ${draft.id}: revision conflict`)
      return
    }

    this.rows.save({
      id: draft.id,
      projectId: draft.projectId,
      threadId: draft.threadId,
      status: draft.status,
      revision: draft.revision,
      content: draft.content,
      payloadJson,
      createdAtMs: existing?.createdAtMs ?? now,
      updatedAtMs: now
    })
  }
}

export class SqliteDomainPlanRepository implements PlanRepo {
  private readonly rows: SqlitePlanRepository

  constructor(db: SqliteDatabase) {
    this.rows = new SqlitePlanRepository(db)
  }

  async get(id: string): Promise<Plan | undefined> {
    const row = this.rows.get(id)
    if (!row) return undefined
    const nodeRows = this.rows.listNodes(id)
    const edgeRows = this.rows.listEdges(id)
    const nodes: PlanNode[] = nodeRows.map((n) => ({
      id: asPlanNodeId(n.id),
      kind: n.kind as PlanNodeKind,
      title: n.title,
      parentId: n.parentId ? asPlanNodeId(n.parentId) : null
    }))
    const edges: PlanEdge[] = edgeRows.map((e) => ({
      from: asPlanNodeId(e.fromNodeId),
      to: asPlanNodeId(e.toNodeId)
    }))
    return {
      id: asPlanId(row.id),
      revision: asPlanRevision(row.revision),
      status: row.status as PlanStatus,
      nodes,
      edges,
      executionGeneration: row.executionGeneration,
      threadId: row.threadId,
      ...(row.draftId ? { draftId: row.draftId } : {})
    }
  }

  async save(plan: Plan, options?: SaveOptions): Promise<void> {
    const existing = this.rows.get(plan.id)
    const now = Date.now()
    if (options?.expectedRevision !== undefined) {
      if (!existing || existing.revision !== options.expectedRevision) {
        throw new RevisionConflictError(
          `Plan ${plan.id}: expected revision ${options.expectedRevision}, have ${existing?.revision ?? 'missing'}`
        )
      }
    }

    const projectId = existing?.projectId ?? 'unknown'
    this.rows.replaceGraph({
      plan: {
        id: plan.id,
        projectId,
        threadId: plan.threadId,
        draftId: plan.draftId ?? null,
        status: plan.status,
        revision: Number(plan.revision),
        executionGeneration: plan.executionGeneration,
        payloadJson: existing?.payloadJson ?? '{}',
        createdAtMs: existing?.createdAtMs ?? now,
        updatedAtMs: now
      },
      nodes: plan.nodes.map((n, index) => ({
        id: n.id,
        planId: plan.id,
        kind: n.kind,
        title: n.title,
        parentId: n.parentId,
        sortOrder: index,
        payloadJson: '{}',
        createdAtMs: now,
        updatedAtMs: now
      })),
      edges: plan.edges.map((e) => ({
        planId: plan.id,
        fromNodeId: e.from,
        toNodeId: e.to
      }))
    })
  }
}

/**
 * Job domain adapter. New inserts require an existing thread row whose id is
 * provided via `bindThread(jobId, threadId)` OR by saving after a CoreJobRecord
 * seed; otherwise insert uses thread_id from a prior row only.
 *
 * For brand-new jobs without a prior row, call `seedFromThread` first.
 */
export class SqliteDomainJobRepository implements JobRepo {
  private readonly rows: SqliteJobRepository
  private readonly db: SqliteDatabase
  private readonly threadBindings = new Map<string, { threadId: string; projectId: string }>()

  constructor(db: SqliteDatabase) {
    this.db = db
    this.rows = new SqliteJobRepository(db)
  }

  /** Bind thread/project context before first save of a new job id. */
  bindThread(jobId: string, threadId: string): void {
    const thread = this.db
      .prepare(`SELECT project_id FROM core_threads WHERE id = ?`)
      .get(threadId) as { project_id: string } | undefined
    if (!thread) {
      throw new Error(`Cannot bind job ${jobId}: thread ${threadId} not found`)
    }
    this.threadBindings.set(jobId, { threadId, projectId: thread.project_id })
  }

  async get(id: string): Promise<Job | undefined> {
    const row = this.rows.get(id)
    if (!row) return undefined
    return {
      id: asJobId(row.id),
      status: row.status as JobStatus,
      planRevision: row.planRevision,
      executionGeneration: row.executionGeneration,
      stateRevision: row.revision
    }
  }

  async save(job: Job, options?: SaveOptions): Promise<void> {
    const existing = this.rows.get(job.id)
    const now = Date.now()

    if (options?.expectedRevision !== undefined) {
      if (!existing || existing.revision !== options.expectedRevision) {
        throw new RevisionConflictError(
          `Job ${job.id}: expected revision ${options.expectedRevision}, have ${existing?.revision ?? 'missing'}`
        )
      }
      const result = this.rows.compareAndSet({
        id: job.id,
        expectedRevision: options.expectedRevision,
        next: {
          status: job.status,
          planRevision: job.planRevision,
          executionGeneration: job.executionGeneration,
          updatedAtMs: now
        }
      })
      if (!result.ok) throw new RevisionConflictError(`Job ${job.id}: revision conflict`)
      return
    }

    if (existing) {
      this.rows.save({
        ...existing,
        status: job.status,
        revision: job.stateRevision,
        planRevision: job.planRevision,
        executionGeneration: job.executionGeneration,
        updatedAtMs: now
      })
      return
    }

    const binding = this.threadBindings.get(job.id)
    if (!binding) {
      throw new Error(
        `Cannot insert job ${job.id} without thread binding; call bindThread(jobId, threadId) first`
      )
    }

    this.rows.save({
      id: job.id,
      projectId: binding.projectId,
      threadId: binding.threadId,
      planId: null,
      status: job.status,
      revision: job.stateRevision,
      planRevision: job.planRevision,
      executionGeneration: job.executionGeneration,
      payloadJson: '{}',
      createdAtMs: now,
      updatedAtMs: now,
      terminalAtMs: null
    })
  }
}

/**
 * Task projection adapter over `core_tasks`.
 * `executionGeneration` / optional slice+milestone live in `payload_json`
 * because `core_tasks` has no generation column.
 */
export class SqliteDomainTaskProjectionRepository implements TaskProjectionRepo {
  private readonly tasks: SqliteTaskRepository
  private readonly jobs: SqliteJobRepository

  constructor(db: SqliteDatabase) {
    this.tasks = new SqliteTaskRepository(db)
    this.jobs = new SqliteJobRepository(db)
  }

  async listForJob(
    jobId: string,
    executionGeneration: number
  ): Promise<readonly ProjectedTask[]> {
    const out: ProjectedTask[] = []
    for (const row of this.tasks.listByJob(jobId)) {
      const projected = toProjectedTask(row)
      if (projected && projected.executionGeneration === executionGeneration) {
        out.push(projected)
      }
    }
    return out
  }

  async get(
    jobId: string,
    executionGeneration: number,
    taskId: string
  ): Promise<ProjectedTask | undefined> {
    const row = this.tasks.get(taskId)
    if (!row || row.jobId !== jobId) return undefined
    const projected = toProjectedTask(row)
    if (!projected || projected.executionGeneration !== executionGeneration) {
      return undefined
    }
    return projected
  }

  async save(record: ProjectedTask): Promise<void> {
    const existing = this.tasks.get(record.task.id)
    const now = Date.now()
    // v1: when generation changes, overwriting the same task id row is OK.
    let projectId: string
    if (existing) {
      projectId = existing.projectId
    } else {
      const job = this.jobs.get(record.jobId)
      if (!job) {
        throw new Error(
          `Cannot save task projection ${record.task.id}: job ${record.jobId} not found`
        )
      }
      projectId = job.projectId
    }

    const payload: TaskProjectionPayload = {
      executionGeneration: record.executionGeneration,
      ...(record.sliceId !== undefined ? { sliceId: record.sliceId } : {}),
      ...(record.milestoneId !== undefined ? { milestoneId: record.milestoneId } : {})
    }

    this.tasks.save({
      id: record.task.id,
      projectId,
      jobId: record.jobId,
      planNodeId: existing?.planNodeId ?? null,
      status: record.status,
      revision: existing ? existing.revision + 1 : 0,
      title: record.task.title ?? null,
      dependencyIdsJson: JSON.stringify(record.task.dependencyIds),
      payloadJson: JSON.stringify(payload),
      createdAtMs: existing?.createdAtMs ?? now,
      updatedAtMs: now
    })
  }
}

export class SqliteDomainAttemptRepository implements AttemptRepo {
  private readonly attempts: SqliteAttemptRepository

  constructor(db: SqliteDatabase) {
    this.attempts = new SqliteAttemptRepository(db)
  }

  async get(id: string): Promise<TaskAttempt | undefined> {
    const row = this.attempts.get(id)
    return row ? toTaskAttempt(row) : undefined
  }

  async save(
    attempt: TaskAttempt,
    opts?: { readonly jobId?: string }
  ): Promise<void> {
    const existing = this.attempts.get(attempt.id)
    const resolvedJobId = opts?.jobId ?? existing?.jobId
    if (!resolvedJobId) {
      throw new Error(`attempt.jobId_required: ${attempt.id}`)
    }
    const now = Date.now()
    this.attempts.save({
      id: attempt.id,
      taskId: attempt.taskId,
      jobId: resolvedJobId,
      status: attempt.status,
      executionGeneration: attempt.executionGeneration,
      idempotencyKey: attempt.idempotencyKey,
      resultHash: attempt.resultHash,
      errorCode: attempt.errorCode,
      payloadJson: existing?.payloadJson ?? '{}',
      createdAtMs: existing?.createdAtMs ?? now,
      updatedAtMs: now
    })
  }

  async listForTask(
    jobId: string,
    taskId: string,
    executionGeneration: number
  ): Promise<readonly TaskAttempt[]> {
    return this.attempts
      .listForTask(jobId, taskId, executionGeneration)
      .map(toTaskAttempt)
  }

  async listNonTerminal(): Promise<readonly (TaskAttempt & { readonly jobId: string })[]> {
    return this.attempts.listNonTerminal().map((row) => ({
      ...toTaskAttempt(row),
      jobId: row.jobId
    }))
  }
}

type LeaseRow = {
  workspace_id: string
  holder_id: string
  acquired_at_ms: number
}

function toWorkspaceLease(row: LeaseRow): WorkspaceLease {
  return {
    workspaceId: row.workspace_id,
    holderId: row.holder_id,
    acquiredAtMs: row.acquired_at_ms
  }
}

export class SqliteDomainWorkspaceLeaseRepository implements WorkspaceLeaseRepo {
  constructor(private readonly db: SqliteDatabase) {}

  async get(workspaceId: string): Promise<WorkspaceLease | undefined> {
    const row = this.db
      .prepare(
        `SELECT workspace_id, holder_id, acquired_at_ms
         FROM core_workspace_leases WHERE workspace_id = ?`
      )
      .get(workspaceId) as LeaseRow | undefined
    return row ? toWorkspaceLease(row) : undefined
  }

  async tryAcquire(lease: WorkspaceLease): Promise<boolean> {
    const run = this.db.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT holder_id FROM core_workspace_leases WHERE workspace_id = ?`
        )
        .get(lease.workspaceId) as { holder_id: string } | undefined
      if (existing && existing.holder_id !== lease.holderId) {
        return false
      }
      this.db
        .prepare(
          `INSERT INTO core_workspace_leases(workspace_id, holder_id, acquired_at_ms)
           VALUES (?, ?, ?)
           ON CONFLICT(workspace_id) DO UPDATE SET
             holder_id = excluded.holder_id,
             acquired_at_ms = excluded.acquired_at_ms`
        )
        .run(lease.workspaceId, lease.holderId, lease.acquiredAtMs)
      return true
    })
    return run()
  }

  async release(workspaceId: string, holderId: string): Promise<void> {
    this.db
      .prepare(
        `DELETE FROM core_workspace_leases
         WHERE workspace_id = ? AND holder_id = ?`
      )
      .run(workspaceId, holderId)
  }

  async clearStale(nowMs: number, maxAgeMs: number): Promise<number> {
    const result = this.db
      .prepare(
        `DELETE FROM core_workspace_leases
         WHERE (? - acquired_at_ms) > ?`
      )
      .run(nowMs, maxAgeMs)
    return result.changes
  }

  async listAll(): Promise<readonly WorkspaceLease[]> {
    const rows = this.db
      .prepare(
        `SELECT workspace_id, holder_id, acquired_at_ms FROM core_workspace_leases`
      )
      .all() as LeaseRow[]
    return rows.map(toWorkspaceLease)
  }
}

type VerificationRow = {
  id: string
  job_id: string
  scope: string
  scope_id: string
  status: string
  execution_generation: number
  verdict: string | null
  payload_json: string
  created_at_ms: number
  updated_at_ms: number
}

function parseVerificationResult(
  payloadJson: string,
  verdict: string | null
): VerificationResult | null {
  if (verdict === null) return null
  try {
    const parsed = JSON.parse(payloadJson) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        verdict: verdict as VerificationVerdict,
        summary: '',
        evidenceRefs: [],
        findings: []
      }
    }
    const obj = parsed as Record<string, unknown>
    const evidenceRefs = Array.isArray(obj.evidenceRefs)
      ? obj.evidenceRefs.filter((r): r is string => typeof r === 'string')
      : []
    const findings = Array.isArray(obj.findings)
      ? obj.findings.filter(
          (f): f is VerificationResult['findings'][number] =>
            f !== null &&
            typeof f === 'object' &&
            typeof (f as { code?: unknown }).code === 'string' &&
            typeof (f as { severity?: unknown }).severity === 'string' &&
            typeof (f as { message?: unknown }).message === 'string'
        )
      : []
    return {
      verdict: verdict as VerificationVerdict,
      summary: typeof obj.summary === 'string' ? obj.summary : '',
      evidenceRefs,
      findings
    }
  } catch {
    return {
      verdict: verdict as VerificationVerdict,
      summary: '',
      evidenceRefs: [],
      findings: []
    }
  }
}

function toVerificationAttempt(row: VerificationRow): VerificationAttempt {
  return {
    id: asVerificationAttemptId(row.id),
    jobId: row.job_id,
    scope: row.scope as VerificationScope,
    scopeId: row.scope_id,
    status: row.status as VerificationAttemptStatus,
    executionGeneration: row.execution_generation,
    result: parseVerificationResult(row.payload_json, row.verdict)
  }
}

export class SqliteDomainVerificationAttemptRepository implements VerificationAttemptRepo {
  constructor(private readonly db: SqliteDatabase) {}

  async get(id: string): Promise<VerificationAttempt | undefined> {
    const row = this.db
      .prepare(
        `SELECT id, job_id, scope, scope_id, status, execution_generation, verdict,
                payload_json, created_at_ms, updated_at_ms
         FROM core_verification_attempts WHERE id = ?`
      )
      .get(id) as VerificationRow | undefined
    return row ? toVerificationAttempt(row) : undefined
  }

  async save(attempt: VerificationAttempt): Promise<void> {
    const existing = this.db
      .prepare(
        `SELECT created_at_ms FROM core_verification_attempts WHERE id = ?`
      )
      .get(attempt.id) as { created_at_ms: number } | undefined
    const now = Date.now()
    const verdict = attempt.result?.verdict ?? null
    const payloadJson = attempt.result
      ? JSON.stringify({
          summary: attempt.result.summary,
          evidenceRefs: attempt.result.evidenceRefs,
          findings: attempt.result.findings
        })
      : '{}'
    this.db
      .prepare(
        `INSERT INTO core_verification_attempts(
           id, job_id, scope, scope_id, status, execution_generation, verdict,
           payload_json, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           job_id = excluded.job_id,
           scope = excluded.scope,
           scope_id = excluded.scope_id,
           status = excluded.status,
           execution_generation = excluded.execution_generation,
           verdict = excluded.verdict,
           payload_json = excluded.payload_json,
           updated_at_ms = excluded.updated_at_ms`
      )
      .run(
        attempt.id,
        attempt.jobId,
        attempt.scope,
        attempt.scopeId,
        attempt.status,
        attempt.executionGeneration,
        verdict,
        payloadJson,
        existing?.created_at_ms ?? now,
        now
      )
  }

  async listForJob(jobId: string): Promise<readonly VerificationAttempt[]> {
    const rows = this.db
      .prepare(
        `SELECT id, job_id, scope, scope_id, status, execution_generation, verdict,
                payload_json, created_at_ms, updated_at_ms
         FROM core_verification_attempts WHERE job_id = ?`
      )
      .all(jobId) as VerificationRow[]
    return rows.map(toVerificationAttempt)
  }

  async listForScope(
    jobId: string,
    scope: VerificationAttempt['scope'],
    scopeId: string
  ): Promise<readonly VerificationAttempt[]> {
    const rows = this.db
      .prepare(
        `SELECT id, job_id, scope, scope_id, status, execution_generation, verdict,
                payload_json, created_at_ms, updated_at_ms
         FROM core_verification_attempts
         WHERE job_id = ? AND scope = ? AND scope_id = ?`
      )
      .all(jobId, scope, scopeId) as VerificationRow[]
    return rows.map(toVerificationAttempt)
  }
}

type RetentionArtifactRow = {
  id: string
  kind: string
  expires_at_ms: number | null
  deleted_at_ms: number | null
}

function toRetainedArtifact(row: RetentionArtifactRow): RetainedArtifact {
  return {
    id: row.id,
    kind: row.kind as ArtifactRetentionKind,
    expiresAtMs: row.expires_at_ms,
    deletedAtMs: row.deleted_at_ms
  }
}

export class SqliteDomainRetentionStore implements RetentionStore {
  private readonly artifacts: SqliteArtifactRepository

  constructor(private readonly db: SqliteDatabase) {
    this.artifacts = new SqliteArtifactRepository(db)
  }

  async list(): Promise<readonly RetainedArtifact[]> {
    // Match InMemoryRetentionStore: return all rows including soft-deleted.
    const rows = this.db
      .prepare(
        `SELECT id, kind, expires_at_ms, deleted_at_ms
         FROM core_artifacts WHERE project_id = ?`
      )
      .all(RETENTION_PROJECT_ID) as RetentionArtifactRow[]
    return rows.map(toRetainedArtifact)
  }

  async save(artifact: RetainedArtifact): Promise<void> {
    const existing = this.artifacts.get(artifact.id)
    const now = Date.now()
    this.artifacts.saveMeta({
      id: artifact.id,
      projectId: RETENTION_PROJECT_ID,
      jobId: null,
      kind: artifact.kind,
      storagePath: '',
      contentSha256: '',
      byteSize: 0,
      payloadJson: existing?.payloadJson ?? '{}',
      createdAtMs: existing?.createdAtMs ?? now,
      updatedAtMs: now,
      expiresAtMs: artifact.expiresAtMs,
      deletedAtMs: artifact.deletedAtMs
    })
  }

  async markDeleted(id: string, deletedAtMs: number): Promise<void> {
    const existing = this.artifacts.get(id)
    if (!existing || existing.projectId !== RETENTION_PROJECT_ID) return
    this.artifacts.softDelete({ id, deletedAtMs })
  }

  async get(id: string): Promise<RetainedArtifact | undefined> {
    const row = this.artifacts.get(id)
    if (!row || row.projectId !== RETENTION_PROJECT_ID) return undefined
    return {
      id: row.id,
      kind: row.kind as ArtifactRetentionKind,
      expiresAtMs: row.expiresAtMs,
      deletedAtMs: row.deletedAtMs
    }
  }
}
