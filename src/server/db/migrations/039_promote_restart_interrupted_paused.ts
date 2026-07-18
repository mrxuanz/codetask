import type { Migration } from './types'

/**
 * P7 one-time: promote Legacy restart-interrupted `paused` rows (no structured
 * suspension) to `pending` so long-term taskProgress heuristics can be deleted.
 * Explicit user_pause / human_dependency / policy_hold were already backfilled by migration 035.
 * Promotion additionally requires a persisted active run owned by this job; progress alone is
 * ambiguous and must remain paused. Provider-started attempts enter policy_hold instead of replay.
 */
export const migration039PromoteRestartInterruptedPaused: Migration = {
  version: 39,
  name: 'promote_restart_interrupted_paused',
  up(db) {
    const candidates = db
      .prepare(
        `
        SELECT id, active_run_id AS activeRunId FROM thread_jobs
        WHERE status = 'paused'
          AND suspension_kind IS NULL
          AND recovery_reason IS NULL
          AND (
            last_error IS NULL
            OR last_error = ''
            OR last_error NOT LIKE '%"code":"job.paused"%'
          )
        `
      )
      .all() as Array<{ id: string; activeRunId: string | null }>

    const listTasks = db.prepare(
      `
      SELECT status, execution_status, recovery_action, blocker_kind
      FROM job_tasks
      WHERE job_id = ?
      `
    )
    const promote = db.prepare(
      `
      UPDATE thread_jobs
      SET status = 'pending',
          continue_after_pause = 0,
          last_error = NULL
      WHERE id = ? AND status = 'paused' AND suspension_kind IS NULL
      `
    )
    const classifyHold = db.prepare(
      `
      UPDATE thread_jobs
      SET suspension_kind = 'policy_hold',
          recovery_reason = ?,
          continue_after_pause = 0
      WHERE id = ? AND status = 'paused' AND suspension_kind IS NULL
      `
    )
    const runBelongsToJob = db.prepare(
      `
      SELECT 1 AS ok
      FROM workload_runs
      WHERE id = ? AND owner_kind = 'thread_job' AND owner_id = ?
      LIMIT 1
      `
    )
    const listAttempts = db.prepare(
      `
      SELECT status, idempotency_key AS idempotencyKey, run_id AS runId
      FROM job_task_attempts
      WHERE job_id = ?
      `
    )

    for (const { id, activeRunId } of candidates) {
      const tasks = listTasks.all(id) as Array<{
        status: string
        execution_status: string | null
        recovery_action: string | null
        blocker_kind: string | null
      }>
      if (
        tasks.some(
          (task) =>
            task.recovery_action === 'pause-human' || task.blocker_kind === 'dependency-human'
        )
      ) {
        continue
      }
      const hasProgress = tasks.some(
        (task) =>
          task.status !== 'queued' ||
          task.execution_status === 'running' ||
          task.execution_status === 'retry-queued'
      )
      if (!hasProgress) {
        classifyHold.run('migration_ambiguous', id)
        continue
      }

      const hasOwnedRun = Boolean(
        activeRunId && (runBelongsToJob.get(activeRunId, id) as { ok: number } | undefined)?.ok
      )
      if (!hasOwnedRun) {
        classifyHold.run('migration_ambiguous', id)
        continue
      }

      const attempts = listAttempts.all(id) as Array<{
        status: string
        idempotencyKey: string
        runId: string | null
      }>
      const activeAttempts = attempts.filter((attempt) => attempt.runId === activeRunId)
      const hasUncertainProviderOutcome = activeAttempts.some(
        (attempt) =>
          (attempt.status === 'running' ||
            attempt.status === 'interrupted' ||
            attempt.status === 'failed') &&
          /^[a-f0-9]{64}$/u.test(attempt.idempotencyKey)
      )
      if (hasUncertainProviderOutcome) {
        classifyHold.run('uncertain_provider_outcome', id)
        continue
      }

      // A `starting` attempt has not crossed the Provider fence. No active attempt means the old
      // run died between committed checkpoints. Both cases are safe to enqueue.
      const onlySafeAttempts = activeAttempts.every(
        (attempt) =>
          attempt.status === 'starting' ||
          attempt.status === 'completed' ||
          !/^[a-f0-9]{64}$/u.test(attempt.idempotencyKey)
      )
      if (onlySafeAttempts) {
        promote.run(id)
      } else {
        classifyHold.run('migration_ambiguous', id)
      }
    }
  }
}
