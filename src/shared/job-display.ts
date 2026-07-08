import type { ThreadJobDto, ThreadJobStatus } from './contracts/jobs'

export interface JobDisplayResolved {
  badge: string
  lifecycle: 'queued' | 'running' | 'pausing' | 'paused' | 'done' | 'failed'
  executionLabel: string
  status: ThreadJobStatus
}

const EXECUTION_DISPLAY_STATUSES = new Set<ThreadJobStatus>([
  'pending',
  'running',
  'pausing',
  'paused',
  'completed',
  'failed',
  'cancelled'
])

export function isExecutionDisplayStatus(status: string): status is ThreadJobStatus {
  return EXECUTION_DISPLAY_STATUSES.has(status as ThreadJobStatus)
}

function resolveLifecycle(status: ThreadJobStatus): JobDisplayResolved['lifecycle'] {
  switch (status) {
    case 'pending':
      return 'queued'
    case 'running':
      return 'running'
    case 'pausing':
      return 'pausing'
    case 'paused':
      return 'paused'
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'failed'
    default:
      return 'queued'
  }
}

export function resolveJobStatusBadgeKey(status: ThreadJobStatus): string {
  switch (status) {
    case 'pending':
      return 'workspace.tasks.status.pending'
    case 'running':
      return 'workspace.tasks.status.running'
    case 'pausing':
      return 'workspace.tasks.status.pausing'
    case 'paused':
      return 'workspace.tasks.status.paused'
    case 'completed':
      return 'workspace.tasks.status.completed'
    case 'failed':
      return 'workspace.tasks.status.failed'
    case 'cancelled':
      return 'workspace.tasks.status.cancelled'
    default:
      return 'workspace.tasks.status.pending'
  }
}

function resolveExecutionLabel(status: ThreadJobStatus): string {
  switch (status) {
    case 'pending':
      return 'Queued'
    case 'running':
      return 'In Progress'
    case 'pausing':
      return 'Pausing...'
    case 'paused':
      return 'Paused'
    case 'completed':
      return 'Done'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
    default:
      return status
  }
}

export function resolveJobStatusBadgeClass(status: ThreadJobStatus): string {
  switch (status) {
    case 'running':
    case 'pausing':
      return 'bg-sky-50 text-sky-700'
    case 'paused':
    case 'cancelled':
      return 'bg-zinc-100 text-zinc-700'
    case 'pending':
      return 'bg-amber-50 text-amber-700'
    case 'completed':
      return 'bg-emerald-50 text-emerald-700'
    case 'failed':
      return 'bg-red-50 text-red-700'
    default:
      return 'bg-muted text-muted-foreground'
  }
}

export function resolveJobStatusDisplay(status: ThreadJobStatus): JobDisplayResolved {
  return {
    badge: resolveJobStatusBadgeKey(status),
    lifecycle: resolveLifecycle(status),
    executionLabel: resolveExecutionLabel(status),
    status
  }
}

export function resolveJobDisplay(job: ThreadJobDto): JobDisplayResolved {
  return resolveJobStatusDisplay(job.status)
}

export function formatExecutionQueueLabel(
  t: (key: string, params?: Record<string, unknown>) => string,
  queue?: ThreadJobDto['queue']
): string | null {
  if (!queue?.position) return null
  if (queue.position === 1 || queue.ahead === 0) {
    return t('workspace.tasks.queue.next')
  }
  return t('workspace.tasks.queue.position', { position: queue.position })
}
