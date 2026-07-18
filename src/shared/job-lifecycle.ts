import { DESIGN_SESSION_WORKSPACE_STATUSES } from './design-session'

export const LAUNCHED_JOB_STATUSES = [
  'pending',
  'running',
  'pausing',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'plan_confirmed'
] as const

export type JobLifecycleBucket = 'in_progress' | 'completed' | 'failed' | 'cancelled'

export function isLaunchedJobStatus(status: string | null | undefined): boolean {
  return Boolean(status && (LAUNCHED_JOB_STATUSES as readonly string[]).includes(status))
}

export function isDraftListEntryLaunched(input: {
  launched?: boolean | undefined
  planStatus?: string | null | undefined
  hasLaunchedJobId?: boolean | undefined
}): boolean {
  if (input.hasLaunchedJobId === true) return true
  if (input.planStatus === 'launched') return true
  const status = input.planStatus
  if (!status) return false
  if ((DESIGN_SESSION_WORKSPACE_STATUSES as readonly string[]).includes(status)) {
    return false
  }
  return isLaunchedJobStatus(status)
}

export function resolveJobLifecycleBucket(status: string): JobLifecycleBucket {
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  return 'in_progress'
}
