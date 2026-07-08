import type { ThreadJobStatus } from './contracts/jobs'

/** Job statuses that benefit from realtime push (hub/SSE). */
export function jobNeedsRealtimeWatch(status: ThreadJobStatus | string): boolean {
  return status === 'pending' || status === 'running' || status === 'pausing' || status === 'planning'
}

/** Stop forwarding hub events once the job reaches a settled control state. */
export function jobHubTerminalStatus(status: ThreadJobStatus | string): boolean {
  return (
    status === 'plan_editing' ||
    status === 'plan_ready' ||
    status === 'paused' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled'
  )
}
