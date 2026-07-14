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

export type TaskAttemptStatus =
  | 'starting'
  | 'running'
  | 'completed'
  | 'interrupted'
  | 'failed'

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
  return createHash('sha256').update(json ?? 'null').digest('hex')
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
 * Open a new attempt for `(jobId, taskId)` unless the task already has a completed attempt.
 * Any leftover non-terminal attempt (from a dead process) is flipped to `interrupted` first so
 * only the newest attempt is ever `running`. Interrupted rows free the stable idempotency key.
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
      input.snapshotPlanRevision ??
      jobRow.snapshotPlanRevision ??
      jobRow.planRevision ??
      0

    const existing = tx
      .select({
        id: jobTaskAttempts.id,
        attemptNo: jobTaskAttempts.attemptNo,
        status: jobTaskAttempts.status,
        idempotencyKey: jobTaskAttempts.idempotencyKey
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

    // Supersede lingering non-terminal attempts and free the stable idempotency key.
    for (const row of existing) {
      if (!NON_TERMINAL_STATUSES.includes(row.status as TaskAttemptStatus)) continue
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
        status: 'running',
        startedAt: now
      })
      .run()

    return { kind: 'started', id, attemptNo, idempotencyKey }
  })
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
export function commitCompletedTaskAttempt(input: CompleteTaskAttemptInput): { resultHash: string } {
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

/** Flip a single job's non-terminal attempts to `interrupted` (called during recovery). */
export function markRunningAttemptsInterruptedForJob(jobId: string): number {
  const now = nowSec()
  const db = getDb()
  return db.transaction((tx) => {
    const rows = tx
      .select({
        id: jobTaskAttempts.id,
        attemptNo: jobTaskAttempts.attemptNo,
        idempotencyKey: jobTaskAttempts.idempotencyKey
      })
      .from(jobTaskAttempts)
      .where(
        and(
          eq(jobTaskAttempts.jobId, jobId),
          inArray(jobTaskAttempts.status, [...NON_TERMINAL_STATUSES])
        )
      )
      .all()

    for (const row of rows) {
      tx.update(jobTaskAttempts)
        .set({
          status: 'interrupted',
          endedAt: now,
          idempotencyKey: `${row.idempotencyKey}:interrupted:${row.attemptNo}`
        })
        .where(eq(jobTaskAttempts.id, row.id))
        .run()
    }
    return rows.length
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
        idempotencyKey: jobTaskAttempts.idempotencyKey
      })
      .from(jobTaskAttempts)
      .where(inArray(jobTaskAttempts.status, [...NON_TERMINAL_STATUSES]))
      .all()

    for (const row of rows) {
      tx.update(jobTaskAttempts)
        .set({
          status: 'interrupted',
          endedAt: now,
          idempotencyKey: `${row.idempotencyKey}:interrupted:${row.attemptNo}`
        })
        .where(eq(jobTaskAttempts.id, row.id))
        .run()
    }
    return rows.length
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
