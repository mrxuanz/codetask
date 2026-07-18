export const JOB_STATES = [
  'planning_queued',
  'planning_running',
  'plan_review',
  'execution_queued',
  'execution_running',
  'pausing',
  'paused',
  'applying_changes',
  'succeeded',
  'failed',
  'cancelled'
] as const

export type JobState = (typeof JOB_STATES)[number]

export const JOB_ACTIONS = [
  'pause',
  'continue',
  'cancel',
  'restart_execution',
  'replan',
  'confirm_plan',
  'edit_plan',
  'delete'
] as const

export type JobAction = (typeof JOB_ACTIONS)[number]

export type ControlIntent = 'none' | 'pause'
export type ResumeTarget = 'planning_queued' | 'execution_queued'
export type RunKind = 'planning' | 'execution'
export type Recoverability = 'recoverable' | 'non_recoverable'

export function isTerminal(state: JobState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled'
}

export function isRunning(state: JobState): boolean {
  return state === 'planning_running' || state === 'execution_running'
}

export function isQueued(state: JobState): boolean {
  return state === 'planning_queued' || state === 'execution_queued'
}
