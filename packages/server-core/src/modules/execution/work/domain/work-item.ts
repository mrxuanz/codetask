import type { ProviderCode, WorkKind, WorkState } from '@codetask/contracts'

export type WorkItemRecord = {
  id: string
  jobId: string
  generation: number
  sourceTaskId: string
  parentWorkId: string | null
  milestoneId: string
  sliceId: string
  kind: WorkKind
  taskKind: string
  sortOrder: number
  title: string
  description: string
  contextMarkdown: string
  abilityCode: string
  providerCode: ProviderCode
  successCriteria: string
  referenceReason: string
  requiredInputs: string[]
  canRunInParallel: boolean
  state: WorkState
  stateRevision: number
  lastErrorJson: string | null
  createdAt: number
  updatedAt: number
}

export type SliceDependencyRecord = {
  jobId: string
  generation: number
  fromSliceId: string
  dependsOnSliceId: string
}

export type WorkDependencyRecord = {
  jobId: string
  generation: number
  fromWorkId: string
  dependsOnWorkId: string
  reason: 'planner' | 'implicit-order' | 'repair'
}

export type ReadyWorkSet = {
  jobId: string
  workIds: string[]
  blocked: Array<{ workId: string; blockers: string[] }>
}

export function isWorkTerminal(state: WorkState): boolean {
  return (
    state === 'succeeded' ||
    state === 'failed' ||
    state === 'blocked' ||
    state === 'cancelled' ||
    state === 'skipped'
  )
}

export function isWorkDone(state: WorkState): boolean {
  return state === 'succeeded' || state === 'skipped'
}
