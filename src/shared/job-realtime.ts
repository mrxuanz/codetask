import type { PlanningSessionViewStatus } from '@codetask/contracts'

/** Canonical execution job states that benefit from realtime push (hub/SSE). */
export function jobNeedsRealtimeWatch(status: string): boolean {
  return (
    status === 'queued' ||
    status === 'running' ||
    status === 'pausing' ||
    status === 'cancelling' ||
    // Legacy design/planning statuses (PlanningSessionView paths)
    status === 'pending' ||
    status === 'planning'
  )
}

/** Stop forwarding hub events once the job reaches a settled control state. */
export function jobHubTerminalStatus(status: PlanningSessionViewStatus | string): boolean {
  return (
    status === 'plan_editing' ||
    status === 'plan_ready' ||
    status === 'paused' ||
    status === 'completed' ||
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'cancelled'
  )
}
