import type { JobState } from '@codetask/contracts'

export interface JobDisplayResolved {
  badge: string
  lifecycle: 'queued' | 'running' | 'pausing' | 'paused' | 'done' | 'failed'
  executionLabel: string
  status: JobState
}

const EXECUTION_DISPLAY_STATUSES = new Set<JobState>([
  'queued',
  'running',
  'pausing',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
  'cancelling'
])

/** Historical status aliases still seen in older Design plan views. */
const LEGACY_STATUS_TO_JOB_STATE: Record<string, JobState> = {
  pending: 'queued',
  completed: 'succeeded'
}

export function normalizeJobState(status: string): JobState | null {
  if (EXECUTION_DISPLAY_STATUSES.has(status as JobState)) return status as JobState
  return LEGACY_STATUS_TO_JOB_STATE[status] ?? null
}

export function isExecutionDisplayStatus(status: string): boolean {
  return normalizeJobState(status) !== null
}

function resolveLifecycle(status: JobState): JobDisplayResolved['lifecycle'] {
  switch (status) {
    case 'queued':
      return 'queued'
    case 'running':
      return 'running'
    case 'pausing':
      return 'pausing'
    case 'paused':
      return 'paused'
    case 'succeeded':
      return 'done'
    case 'failed':
    case 'cancelled':
    case 'cancelling':
      return 'failed'
    default:
      return 'queued'
  }
}

export function resolveJobStatusBadgeKey(status: string): string {
  const state = normalizeJobState(status) ?? (status as JobState)
  switch (state) {
    case 'queued':
      return 'workspace.tasks.status.pending'
    case 'running':
      return 'workspace.tasks.status.running'
    case 'pausing':
      return 'workspace.tasks.status.pausing'
    case 'paused':
      return 'workspace.tasks.status.paused'
    case 'succeeded':
      return 'workspace.tasks.status.completed'
    case 'failed':
      return 'workspace.tasks.status.failed'
    case 'cancelled':
    case 'cancelling':
      return 'workspace.tasks.status.cancelled'
    default:
      return 'workspace.tasks.status.pending'
  }
}

function resolveExecutionLabel(status: JobState): string {
  switch (status) {
    case 'queued':
      return 'Queued'
    case 'running':
      return 'In Progress'
    case 'pausing':
      return 'Pausing...'
    case 'paused':
      return 'Paused'
    case 'succeeded':
      return 'Done'
    case 'failed':
      return 'Failed'
    case 'cancelled':
    case 'cancelling':
      return 'Cancelled'
    default:
      return status
  }
}

export function resolveJobStatusBadgeClass(status: string): string {
  const state = normalizeJobState(status) ?? status
  switch (state) {
    case 'running':
    case 'pausing':
      return 'bg-sky-50 text-sky-700'
    case 'paused':
    case 'cancelled':
    case 'cancelling':
      return 'bg-zinc-100 text-zinc-700'
    case 'queued':
    case 'pending':
      return 'bg-amber-50 text-amber-700'
    case 'succeeded':
    case 'completed':
      return 'bg-emerald-50 text-emerald-700'
    case 'failed':
      return 'bg-red-50 text-red-700'
    default:
      return 'bg-muted text-muted-foreground'
  }
}

export function resolveJobStatusDisplay(status: string): JobDisplayResolved {
  const state = normalizeJobState(status) ?? 'queued'
  return {
    badge: resolveJobStatusBadgeKey(state),
    lifecycle: resolveLifecycle(state),
    executionLabel: resolveExecutionLabel(state),
    status: state
  }
}

export function resolveJobDisplay(job: { status: string; state?: string }): JobDisplayResolved {
  return resolveJobStatusDisplay(job.state ?? job.status)
}

export function formatExecutionQueueLabel(
  t: (key: string, params?: Record<string, unknown>) => string,
  queue?: { position: number | null; ahead: number } | null
): string | null {
  if (!queue?.position) return null
  if (queue.position === 1 || queue.ahead === 0) {
    return t('workspace.tasks.queue.next')
  }
  return t('workspace.tasks.queue.position', { position: queue.position })
}
