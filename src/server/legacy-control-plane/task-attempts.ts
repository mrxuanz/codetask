import { createHash, randomUUID } from 'crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '../db'
import { jobTaskAttempts, jobTasks } from '../db/schema'

/**
 * FIX-PLAN F3-B (§8.3): task-attempt / checkpoint ledger used for crash recovery.
 *
 * Guarantees:
 *   - `UNIQUE(job_id, task_id, attempt_no)` and `UNIQUE(idempotency_key)` (DB-enforced).
 *   - A completed task is never re-run: `beginTaskAttempt` returns `already-completed`.
 *   - Task success + result hash + attempt-completed + job checkpoint (job_tasks status stamp)
 *     commit in the same transaction (`commitCompletedTaskAttempt`).
 *   - On startup, stale `running`/`starting` attempts convert to `interrupted`; a fresh attempt is
 *     then created under the same stable `(job_id, task_id)` identity with a new idempotency key.
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
}

export type BeginTaskAttemptResult =
  | { kind: 'already-completed' }
  | { kind: 'started'; id: string; attemptNo: number; idempotencyKey: string }

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

/** Stable, per-attempt idempotency key. Task identity `(jobId, taskId)` is stable across attempts. */
export function deriveIdempotencyKey(jobId: string, taskId: string, attemptNo: number): string {
  return `${jobId}:${taskId}:${attemptNo}`
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
 * only the newest attempt is ever `running`.
 */
export function beginTaskAttempt(input: BeginTaskAttemptInput): BeginTaskAttemptResult {
  const db = getDb()
  const now = nowSec()

  return db.transaction((tx): BeginTaskAttemptResult => {
    const existing = tx
      .select({ attemptNo: jobTaskAttempts.attemptNo, status: jobTaskAttempts.status })
      .from(jobTaskAttempts)
      .where(and(eq(jobTaskAttempts.jobId, input.jobId), eq(jobTaskAttempts.taskId, input.taskId)))
      .all()

    if (existing.some((row) => row.status === 'completed')) {
      return { kind: 'already-completed' }
    }

    // Supersede any lingering non-terminal attempt from a previous process.
    tx.update(jobTaskAttempts)
      .set({ status: 'interrupted', endedAt: now })
      .where(
        and(
          eq(jobTaskAttempts.jobId, input.jobId),
          eq(jobTaskAttempts.taskId, input.taskId),
          inArray(jobTaskAttempts.status, [...NON_TERMINAL_STATUSES])
        )
      )
      .run()

    const maxAttemptNo = existing.reduce((max, row) => Math.max(max, row.attemptNo), 0)
    const attemptNo = maxAttemptNo + 1
    const idempotencyKey = deriveIdempotencyKey(input.jobId, input.taskId, attemptNo)
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
 * checkpoint (job_tasks status stamp) in the SAME transaction.
 */
export function commitCompletedTaskAttempt(input: CompleteTaskAttemptInput): { resultHash: string } {
  const db = getDb()
  const now = nowSec()
  const resultHash = hashTaskResult(input.result)

  db.transaction((tx) => {
    tx.update(jobTaskAttempts)
      .set({ status: 'completed', resultHash, errorJson: null, endedAt: now })
      .where(
        and(
          eq(jobTaskAttempts.jobId, input.jobId),
          eq(jobTaskAttempts.taskId, input.taskId),
          eq(jobTaskAttempts.attemptNo, input.attemptNo)
        )
      )
      .run()

    // Job checkpoint: stamp the task row terminal-complete in the same transaction. The executor's
    // subsequent progress persist rewrites the same completed state idempotently.
    tx.update(jobTasks)
      .set({ status: 'completed', executionStatus: 'completed' })
      .where(and(eq(jobTasks.jobId, input.jobId), eq(jobTasks.taskId, input.taskId)))
      .run()
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
  getDb()
    .update(jobTaskAttempts)
    .set({ status: 'failed', errorJson: input.errorJson ?? null, endedAt: now })
    .where(
      and(
        eq(jobTaskAttempts.jobId, input.jobId),
        eq(jobTaskAttempts.taskId, input.taskId),
        eq(jobTaskAttempts.attemptNo, input.attemptNo)
      )
    )
    .run()
}

/** Flip a single job's non-terminal attempts to `interrupted` (called during recovery). */
export function markRunningAttemptsInterruptedForJob(jobId: string): number {
  const now = nowSec()
  const result = getDb()
    .update(jobTaskAttempts)
    .set({ status: 'interrupted', endedAt: now })
    .where(
      and(
        eq(jobTaskAttempts.jobId, jobId),
        inArray(jobTaskAttempts.status, [...NON_TERMINAL_STATUSES])
      )
    )
    .run()
  return result.changes ?? 0
}

/** Startup fence: flip every process-orphaned attempt to `interrupted`. */
export function markAllRunningAttemptsInterrupted(): number {
  const now = nowSec()
  const result = getDb()
    .update(jobTaskAttempts)
    .set({ status: 'interrupted', endedAt: now })
    .where(inArray(jobTaskAttempts.status, [...NON_TERMINAL_STATUSES]))
    .run()
  return result.changes ?? 0
}

export function countAttempts(jobId: string, taskId: string): number {
  const row = getDb()
    .select({ count: sql<number>`count(*)` })
    .from(jobTaskAttempts)
    .where(and(eq(jobTaskAttempts.jobId, jobId), eq(jobTaskAttempts.taskId, taskId)))
    .get()
  return row?.count ?? 0
}
