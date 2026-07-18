import { createHash, randomUUID } from 'crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '../db'
import { jobTaskAttempts, jobTasks, threadJobs } from '../db/schema'

/**
 * FIX-PLAN F3-B (§8.3) + R1 remediation: task-attempt / checkpoint ledger for crash recovery.
 *
 * Guarantees:
 *   - `UNIQUE(job_id, task_id, attempt_no)` and `UNIQUE(idempotency_key)` (DB-enforced).
 *   - Logical task identity uses a stable idempotency key (no attemptNo); retries keep the same key.
 *   - A completed task is never re-run: `beginTaskAttempt` returns `already-completed`.
 *   - Task success + result hash + attempt-completed + job checkpoint commit in one transaction.
 *   - `task_id` must belong to the same `job_id` (validated in-transaction).
 */

export type TaskAttemptStatus = 'starting' | 'running' | 'completed' | 'interrupted' | 'failed'

const NON_TERMINAL_STATUSES: readonly TaskAttemptStatus[] = ['starting', 'running']

export interface BeginTaskAttemptInput {
  jobId: string
  taskId: string
  runId?: string | null
  /** Frozen plan revision for this job snapshot; defaults from thread_jobs when omitted. */
  snapshotPlanRevision?: number
}

export type BeginTaskAttemptResult =
  | { kind: 'already-completed' }
  | {
      kind: 'blocked-uncertain'
      attemptNo: number
      idempotencyKey: string
      status: 'running' | 'interrupted' | 'failed'
    }
  | { kind: 'resumed'; attemptNo: number; idempotencyKey: string }
  | { kind: 'started'; id: string; attemptNo: number; idempotencyKey: string }

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Stable logical-task idempotency key. Does NOT include attemptNo so retries share one side-effect identity.
 */
export function deriveTaskIdempotencyKey(input: {
  jobId: string
  taskId: string
  snapshotPlanRevision: number
}): string {
  const identity = `${input.jobId}:${input.taskId}:${input.snapshotPlanRevision}`
  return createHash('sha256').update(identity).digest('hex')
}

/**
 * @deprecated Prefer `deriveTaskIdempotencyKey`. Kept for older call sites that still pass attemptNo;
 * ignores attemptNo so the logical key stays stable across retries.
 */
export function deriveIdempotencyKey(
  jobId: string,
  taskId: string,
  _attemptNo?: number,
  snapshotPlanRevision = 0
): string {
  return deriveTaskIdempotencyKey({ jobId, taskId, snapshotPlanRevision })
}

/** Deterministic result hash for a task's reported evidence packet. */
export function hashTaskResult(value: unknown): string {
  const json = value === undefined ? 'null' : JSON.stringify(value)
  return createHash('sha256')
    .update(json ?? 'null')
    .digest('hex')
}

export function hasCompletedAttempt(jobId: string, taskId: string): boolean {
  const rows = getDb()
    .select({ id: jobTaskAttempts.id })
    .from(jobTaskAttempts)
    .where(
      and(
        eq(jobTaskAttempts.jobId, jobId),
        eq(jobTaskAttempts.taskId, taskId),
        eq(jobTaskAttempts.status, 'completed')
      )
    )
    .all()
  return rows.length > 0
}

/**
 * Open a new attempt for `(jobId, taskId)` unless the task already has a completed attempt or an
 * earlier Provider invocation has an unknown outcome. `starting` means no Provider process/tool
 * has been invoked yet and is safe to supersede. Once an attempt reaches `running`, its stable key
 * remains occupied across failure/interruption so crash recovery cannot replay arbitrary external
 * side effects automatically.
 */
export function beginTaskAttempt(input: BeginTaskAttemptInput): BeginTaskAttemptResult {
  const db = getDb()
  const now = nowSec()

  return db.transaction((tx): BeginTaskAttemptResult => {
    const jobRow = tx
      .select({
        id: threadJobs.id,
        snapshotPlanRevision: threadJobs.snapshotPlanRevision,
        planRevision: threadJobs.planRevision
      })
      .from(threadJobs)
      .where(eq(threadJobs.id, input.jobId))
      .get()

    if (!jobRow) {
      throw new Error('task_attempt.job_not_found')
    }

    const taskRow = tx
      .select({ taskId: jobTasks.taskId })
      .from(jobTasks)
      .where(and(eq(jobTasks.jobId, input.jobId), eq(jobTasks.taskId, input.taskId)))
      .get()

    if (!taskRow) {
      throw new Error('task_attempt.task_not_in_job')
    }

    const snapshotPlanRevision =
      input.snapshotPlanRevision ?? jobRow.snapshotPlanRevision ?? jobRow.planRevision ?? 0

    const existing = tx
      .select({
        id: jobTaskAttempts.id,
        attemptNo: jobTaskAttempts.attemptNo,
        status: jobTaskAttempts.status,
        idempotencyKey: jobTaskAttempts.idempotencyKey,
        runId: jobTaskAttempts.runId
      })
      .from(jobTaskAttempts)
      .where(and(eq(jobTaskAttempts.jobId, input.jobId), eq(jobTaskAttempts.taskId, input.taskId)))
      .all()

    if (existing.some((row) => row.status === 'completed')) {
      return { kind: 'already-completed' }
    }

    const idempotencyKey = deriveTaskIdempotencyKey({
      jobId: input.jobId,
      taskId: input.taskId,
      snapshotPlanRevision
    })

    const uncertain = existing.find(
      (row) =>
        row.idempotencyKey === idempotencyKey &&
        (row.status === 'running' || row.status === 'interrupted' || row.status === 'failed')
    )
    if (uncertain) {
      // A controlled retry inside the same live run continues the same durable attempt and key.
      // Cross-run recovery is deliberately excluded: it cannot prove the old Provider stopped at
      // a side-effect boundary and therefore requires explicit user authorization below.
      if (
        uncertain.status === 'running' &&
        input.runId != null &&
        uncertain.runId === input.runId
      ) {
        return {
          kind: 'resumed',
          attemptNo: uncertain.attemptNo,
          idempotencyKey
        }
      }
      return {
        kind: 'blocked-uncertain',
        attemptNo: uncertain.attemptNo,
        idempotencyKey,
        status: uncertain.status as 'running' | 'interrupted' | 'failed'
      }
    }

    // A lingering `starting` row is safe to supersede because the durable Provider-start fence was
    // never crossed. Preserve it for diagnosis while freeing the logical key for the retry.
    for (const row of existing) {
      if (row.status !== 'starting') continue
      tx.update(jobTaskAttempts)
        .set({
          status: 'interrupted',
          endedAt: now,
          idempotencyKey: `${row.idempotencyKey}:interrupted:${row.attemptNo}`
        })
        .where(eq(jobTaskAttempts.id, row.id))
        .run()
    }

    const maxAttemptNo = existing.reduce((max, row) => Math.max(max, row.attemptNo), 0)
    const attemptNo = maxAttemptNo + 1
    const id = `jta-${randomUUID()}`

    tx.insert(jobTaskAttempts)
      .values({
        id,
        jobId: input.jobId,
        taskId: input.taskId,
        runId: input.runId ?? null,
        attemptNo,
        idempotencyKey,
        status: 'starting',
        startedAt: now
      })
      .run()

    return { kind: 'started', id, attemptNo, idempotencyKey }
  })
}

/**
 * Record authorization to replay tasks whose Provider outcome is uncertain.
 * Called by user-driven resume/continue, and by auto-resume after process death once the old
 * runtime/slot is confirmed closed. The next attempt still receives the same logical idempotency
 * key; the suffix is retained on the old row as an auditable record that automatic replay of the
 * prior fence was explicitly cleared.
 */
export function authorizeUncertainTaskAttemptReplayForJob(jobId: string): number {
  const now = nowSec()
  return getDb().transaction((tx) => {
    const rows = tx
      .select({
        id: jobTaskAttempts.id,
        attemptNo: jobTaskAttempts.attemptNo,
        idempotencyKey: jobTaskAttempts.idempotencyKey,
        status: jobTaskAttempts.status
      })
      .from(jobTaskAttempts)
      .where(
        and(
          eq(jobTaskAttempts.jobId, jobId),
          inArray(jobTaskAttempts.status, ['running', 'interrupted', 'failed'])
        )
      )
      .all()
      // Stable logical keys are raw SHA-256 hex. Suffixed rows were already superseded or
      // explicitly authorized and must not be rewritten by repeated control requests.
      .filter((row) => /^[a-f0-9]{64}$/u.test(row.idempotencyKey))

    for (const row of rows) {
      const result = tx
        .update(jobTaskAttempts)
        .set({
          status: 'interrupted',
          endedAt: now,
          idempotencyKey: `${row.idempotencyKey}:authorized-replay:${row.attemptNo}`
        })
        .where(
          and(
            eq(jobTaskAttempts.id, row.id),
            eq(jobTaskAttempts.idempotencyKey, row.idempotencyKey),
            eq(jobTaskAttempts.status, row.status as TaskAttemptStatus)
          )
        )
        .run()
      if ((result.changes ?? 0) !== 1) {
        throw new Error('task_attempt.replay_authorization_conflict')
      }
    }
    return rows.length
  })
}

/** True when any attempt still holds a stable logical key that blocks automatic replay. */
export function jobHasUncertainReplayFence(jobId: string): boolean {
  const rows = getDb()
    .select({
      idempotencyKey: jobTaskAttempts.idempotencyKey,
      status: jobTaskAttempts.status
    })
    .from(jobTaskAttempts)
    .where(
      and(
        eq(jobTaskAttempts.jobId, jobId),
        inArray(jobTaskAttempts.status, ['running', 'interrupted', 'failed'])
      )
    )
    .all()
  return rows.some((row) => /^[a-f0-9]{64}$/u.test(row.idempotencyKey))
}

/**
 * Cross the durable side-effect fence immediately before invoking a Provider. After this succeeds,
 * the stable key must never be freed automatically: a crash or ambiguous Provider failure is an
 * at-most-once outcome that requires a new logical task revision to run again.
 */
export function markTaskAttemptProviderStarted(input: {
  jobId: string
  taskId: string
  attemptNo: number
}): void {
  const result = getDb()
    .update(jobTaskAttempts)
    .set({ status: 'running' })
    .where(
      and(
        eq(jobTaskAttempts.jobId, input.jobId),
        eq(jobTaskAttempts.taskId, input.taskId),
        eq(jobTaskAttempts.attemptNo, input.attemptNo),
        eq(jobTaskAttempts.status, 'starting')
      )
    )
    .run()

  if ((result.changes ?? 0) !== 1) {
    throw new Error('task_attempt.provider_start_conflict')
  }
}

export interface CompleteTaskAttemptInput {
  jobId: string
  taskId: string
  attemptNo: number
  /** Reported evidence packet (or any serialisable result). Used to derive the result hash. */
  result: unknown
}

/**
 * Commit task success atomically: attempt → completed (+ result hash + ended_at) AND the job
 * checkpoint (job_tasks status stamp + evidence) in the SAME transaction.
 */
export function commitCompletedTaskAttempt(input: CompleteTaskAttemptInput): {
  resultHash: string
} {
  const db = getDb()
  const now = nowSec()
  const resultHash = hashTaskResult(input.result)
  const evidenceJson =
    input.result === undefined || input.result === null ? null : JSON.stringify(input.result)

  db.transaction((tx) => {
    const attemptUpdate = tx
      .update(jobTaskAttempts)
      .set({ status: 'completed', resultHash, errorJson: null, endedAt: now })
      .where(
        and(
          eq(jobTaskAttempts.jobId, input.jobId),
          eq(jobTaskAttempts.taskId, input.taskId),
          eq(jobTaskAttempts.attemptNo, input.attemptNo),
          eq(jobTaskAttempts.status, 'running')
        )
      )
      .run()

    if (attemptUpdate.changes !== 1) {
      throw new Error('task_attempt.commit_conflict')
    }

    const taskUpdate = tx
      .update(jobTasks)
      .set({
        status: 'completed',
        executionStatus: 'completed',
        ...(evidenceJson != null ? { evidenceJson } : {})
      })
      .where(and(eq(jobTasks.jobId, input.jobId), eq(jobTasks.taskId, input.taskId)))
      .run()

    if (taskUpdate.changes !== 1) {
      throw new Error('task_checkpoint.commit_conflict')
    }
  })

  return { resultHash }
}

export interface FailTaskAttemptInput {
  jobId: string
  taskId: string
  attemptNo: number
  errorJson?: string | null
}

export function markTaskAttemptFailed(input: FailTaskAttemptInput): void {
  const now = nowSec()
  const result = getDb()
    .update(jobTaskAttempts)
    .set({ status: 'failed', errorJson: input.errorJson ?? null, endedAt: now })
    .where(
      and(
        eq(jobTaskAttempts.jobId, input.jobId),
        eq(jobTaskAttempts.taskId, input.taskId),
        eq(jobTaskAttempts.attemptNo, input.attemptNo),
        inArray(jobTaskAttempts.status, [...NON_TERMINAL_STATUSES])
      )
    )
    .run()

  if ((result.changes ?? 0) !== 1) {
    throw new Error('task_attempt.fail_conflict')
  }
}

function interruptAttempts(
  rows: Array<{ id: string; attemptNo: number; idempotencyKey: string; status: string }>,
  now: number,
  update: (input: {
    id: string
    status: 'interrupted'
    endedAt: number
    idempotencyKey?: string
  }) => void
): number {
  for (const row of rows) {
    update({
      id: row.id,
      status: 'interrupted',
      endedAt: now,
      // `starting` is known not to have crossed the Provider boundary, so it may safely free the
      // stable key. `running` is ambiguous and deliberately keeps the key as a replay fence.
      ...(row.status === 'starting'
        ? { idempotencyKey: `${row.idempotencyKey}:interrupted-safe:${row.attemptNo}` }
        : {})
    })
  }
  return rows.length
}

/** Flip a single job's non-terminal attempts to `interrupted` (called during recovery). */
export function markRunningAttemptsInterruptedForJob(jobId: string): number {
  const now = nowSec()
  const db = getDb()
  return db.transaction((tx) => {
    const rows = tx
      .select({
        id: jobTaskAttempts.id,
        attemptNo: jobTaskAttempts.attemptNo,
        idempotencyKey: jobTaskAttempts.idempotencyKey,
        status: jobTaskAttempts.status
      })
      .from(jobTaskAttempts)
      .where(
        and(
          eq(jobTaskAttempts.jobId, jobId),
          inArray(jobTaskAttempts.status, [...NON_TERMINAL_STATUSES])
        )
      )
      .all()

    return interruptAttempts(rows, now, (patch) => {
      tx.update(jobTaskAttempts)
        .set({
          status: patch.status,
          endedAt: patch.endedAt,
          ...(patch.idempotencyKey ? { idempotencyKey: patch.idempotencyKey } : {})
        })
        .where(eq(jobTaskAttempts.id, patch.id))
        .run()
    })
  })
}

/** Startup fence: flip every process-orphaned attempt to `interrupted`. */
export function markAllRunningAttemptsInterrupted(): number {
  const now = nowSec()
  const db = getDb()
  return db.transaction((tx) => {
    const rows = tx
      .select({
        id: jobTaskAttempts.id,
        attemptNo: jobTaskAttempts.attemptNo,
        idempotencyKey: jobTaskAttempts.idempotencyKey,
        status: jobTaskAttempts.status
      })
      .from(jobTaskAttempts)
      .where(inArray(jobTaskAttempts.status, [...NON_TERMINAL_STATUSES]))
      .all()

    return interruptAttempts(rows, now, (patch) => {
      tx.update(jobTaskAttempts)
        .set({
          status: patch.status,
          endedAt: patch.endedAt,
          ...(patch.idempotencyKey ? { idempotencyKey: patch.idempotencyKey } : {})
        })
        .where(eq(jobTaskAttempts.id, patch.id))
        .run()
    })
  })
}

export function countAttempts(jobId: string, taskId: string): number {
  const row = getDb()
    .select({ count: sql<number>`count(*)` })
    .from(jobTaskAttempts)
    .where(and(eq(jobTaskAttempts.jobId, jobId), eq(jobTaskAttempts.taskId, taskId)))
    .get()
  return row?.count ?? 0
}
