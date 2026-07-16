import type { Migration } from './types'

/**
 * P7 one-time: promote Legacy restart-interrupted `paused` rows (no structured
 * suspension) to `pending` so long-term taskProgress heuristics can be deleted.
 * Explicit user_pause / human_dependency / policy_hold were already backfilled
 * by migration 035; remaining null-suspension paused jobs with task progress
 * evidence are treated as recoverable restart interrupts.
 */
export const migration039PromoteRestartInterruptedPaused: Migration = {
  version: 39,
  name: 'promote_restart_interrupted_paused',
  up(db) {
    const candidates = db
      .prepare(
        `
        SELECT id FROM thread_jobs
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
      .all() as Array<{ id: string }>

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

    for (const { id } of candidates) {
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
      if (!hasProgress) continue
      promote.run(id)
    }
  }
}
