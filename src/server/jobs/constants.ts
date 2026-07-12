/**
 * Statuses eligible for /tasks after the execution tree is confirmed & enqueued.
 * Planning-phase rows (`planning` / `plan_editing`, or failed/cancelled before
 * planConfirmedAt) stay in the create/draft workspace only.
 */
export const TASK_LIST_JOB_STATUSES = [
  'plan_confirmed',
  'pending',
  'running',
  'pausing',
  'paused',
  'completed',
  'failed',
  'cancelled'
] as const

export const PLAN_WORKSPACE_STATUSES = ['planning', 'plan_editing'] as const

/** Task list visibility: confirmed launch only — not mid-planning stubs. */
export function isTaskListVisibleJob(job: {
  status: string
  planConfirmedAt?: number | null
}): boolean {
  if (job.planConfirmedAt == null) return false
  return (TASK_LIST_JOB_STATUSES as readonly string[]).includes(job.status)
}
