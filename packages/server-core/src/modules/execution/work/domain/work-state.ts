import type { WorkState } from '@codetask/contracts'

export const WORK_ACTIVE_STATES: WorkState[] = ['leased', 'running', 'reported']

export function canTransitionWork(from: WorkState, to: WorkState): boolean {
  const allowed: Record<WorkState, WorkState[]> = {
    pending: ['leased', 'cancelled', 'skipped'],
    leased: ['running', 'pending', 'cancelled'],
    running: ['reported', 'failed', 'blocked', 'cancelled'],
    reported: ['succeeded', 'failed', 'blocked'],
    succeeded: [],
    failed: [],
    blocked: [],
    cancelled: [],
    skipped: []
  }
  return allowed[from]?.includes(to) ?? false
}
