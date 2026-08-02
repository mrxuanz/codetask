import type { JobControlIntent, JobState } from '@codetask/contracts'

export type JobRecord = {
  id: string
  submissionId: string
  submissionHash: string
  idempotencyKey: string
  actorId: string
  projectId: string
  sourceDraftId: string
  sourcePlanningSessionId: string
  title: string
  summary: string
  workspaceRoot: string
  canonicalWorkspaceRoot: string
  state: JobState
  stateRevision: number
  controlIntent: JobControlIntent
  executionGeneration: number
  currentRunId: string | null
  suspensionKind: string | null
  recoveryReason: string | null
  lastErrorJson: string | null
  queuedAt: number | null
  startedAt: number | null
  terminalAt: number | null
  createdAt: number
  updatedAt: number
}

export function isTerminalJobState(state: JobState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled'
}

export function isActiveJobState(state: JobState): boolean {
  return state === 'running' || state === 'pausing' || state === 'cancelling'
}
