export const THREAD_STATUSES = ['draft'] as const
export const RUNTIME_STATUSES = ['idle', 'running', 'error'] as const

/**
 * Historical CHECK values for pre-055 threads.wizard_phase / migration replay only.
 * Column removed in migration 055; constant retained so older migration SQL still compiles.
 */
export const WIZARD_PHASES = [
  'collect',
  'draft_review',
  'plan_generating',
  'plan_edit',
  'ready_to_launch'
] as const

/**
 * Historical THREAD_KIND CHECK values for migrations ≤055 table rebuilds.
 * Live schema after 056 only allows `chat`.
 */
export const LEGACY_THREAD_KINDS = ['chat', 'create_task', 'task_snapshot'] as const

/** Live threads.thread_kind CHECK values (migration 056+). */
export const THREAD_KINDS = ['chat'] as const
export const TITLE_SOURCES = ['auto', 'manual'] as const

export const MESSAGE_ROLES = ['user', 'assistant', 'system'] as const

/**
 * Historical message kind CHECK values for migrations ≤055 table rebuilds.
 * Live schema after 056 only allows `text` (Design owns drafts; Conversation writes text).
 */
export const LEGACY_MESSAGE_KINDS = ['text', 'task-launch-draft', 'wizard-handoff'] as const

/** Live thread_messages.kind CHECK values (migration 056+). */
export const MESSAGE_KINDS = ['text'] as const

export const JOB_STATUSES = [
  'pending',
  'planning',
  'plan_editing',
  'plan_confirmed',
  'plan_ready',
  'published',
  'running',
  'pausing',
  'paused',
  'completed',
  'failed',
  'cancelled'
] as const

export const TASK_PHASES = ['idle', 'running', 'completed', 'failed'] as const
export const TASK_STATUSES = ['pending', 'running', 'completed', 'failed'] as const
export const JOB_TASK_STATUSES = ['queued', 'running', 'completed', 'failed', 'skipped'] as const

export const PLAN_PHASES = [
  'idle',
  'planning',
  'plan_ready',
  'failed',
  'cleanup_failed',
  'needs_auth'
] as const
export const PLAN_STATUSES = ['pending', 'running', 'completed', 'failed'] as const

/** Legacy CHECK values for migration 003 job_events table only. Not used by 06 realtime. */
export const JOB_EVENT_TYPES = [
  'job_snapshot',
  'plan_progress',
  'task_progress',
  'job_done',
  'error'
] as const

export function sqlInList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(', ')
}
