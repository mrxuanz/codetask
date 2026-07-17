export const THREAD_STATUSES = ['draft'] as const
export const RUNTIME_STATUSES = ['idle', 'running', 'error'] as const
export const WIZARD_PHASES = [
  'collect',
  'draft_review',
  'plan_generating',
  'plan_edit',
  'ready_to_launch'
] as const
export const THREAD_KINDS = ['chat', 'create_task', 'task_snapshot'] as const
export const TITLE_SOURCES = ['auto', 'manual'] as const

export const MESSAGE_ROLES = ['user', 'assistant', 'system'] as const
export const MESSAGE_KINDS = ['text', 'task-launch-draft', 'wizard-handoff'] as const

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
