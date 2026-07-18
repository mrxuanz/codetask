import type { JobState, ControlIntent, ResumeTarget } from '@shared/contracts/control-plane'
import { JOB_STATES } from '@shared/contracts/control-plane'

export function parseJobState(value: string): JobState {
  if (!JOB_STATES.includes(value as JobState)) {
    throw new Error(`Invalid job state: ${value}`)
  }
  return value as JobState
}

export function parseControlIntent(value: string): ControlIntent {
  if (value !== 'none' && value !== 'pause') {
    throw new Error(`Invalid control intent: ${value}`)
  }
  return value
}

export function parseResumeTarget(value: string): ResumeTarget {
  if (value !== 'planning_queued' && value !== 'execution_queued') {
    throw new Error(`Invalid resume target: ${value}`)
  }
  return value
}
