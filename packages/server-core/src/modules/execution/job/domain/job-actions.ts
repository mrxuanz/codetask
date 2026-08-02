import type { JobAction, JobControlIntent, JobState } from '@codetask/contracts'
import { isTerminalJobState } from './job-state.ts'

export function allowedJobActions(input: {
  state: JobState
  controlIntent: JobControlIntent
}): JobAction[] {
  const { state, controlIntent } = input
  if (isTerminalJobState(state)) {
    if (state === 'failed' || state === 'cancelled') {
      return ['restart', 'delete']
    }
    return ['delete']
  }
  switch (state) {
    case 'queued':
      return ['cancel', 'delete']
    case 'running':
      return controlIntent === 'pause' ? ['continue'] : ['pause', 'cancel']
    case 'pausing':
      return ['continue', 'cancel']
    case 'paused':
      return ['continue', 'cancel', 'restart', 'delete']
    case 'cancelling':
      return []
    default:
      return []
  }
}
