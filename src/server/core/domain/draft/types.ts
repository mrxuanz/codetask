export const EXECUTION_TASK_KINDS = [
  'project-setup',
  'dependency-management',
  'scaffolding',
  'backend-implementation',
  'frontend-implementation',
  'data-modeling',
  'testing-validation',
  'documentation-handoff',
  'general-implementation'
] as const

export type ExecutionTaskKind = (typeof EXECUTION_TASK_KINDS)[number]

export interface ExecutionTask {
  readonly id: string
  readonly title: string
  readonly objective: string
  readonly kind: ExecutionTaskKind
  readonly estimatedMinutes: number
  readonly files: readonly string[]
  readonly dependsOn: readonly string[]
  readonly acceptanceCriteria: readonly string[]
  readonly attachmentIds: readonly string[]
}

export interface ExecutionSlice {
  readonly id: string
  readonly title: string
  readonly objective: string
  readonly successCriteria: string
  readonly dependsOn: readonly string[]
  readonly tasks: readonly ExecutionTask[]
}

export interface ExecutionMilestone {
  readonly id: string
  readonly title: string
  readonly objective: string
  readonly successCriteria: string
  readonly slices: readonly ExecutionSlice[]
}

export interface ExecutionTree {
  readonly schemaVersion: 1
  readonly title: string
  readonly summary: string
  readonly milestones: readonly ExecutionMilestone[]
}

export interface DraftContent {
  readonly title: string
  readonly objective: string
  readonly requirements: string
  readonly constraints: string
  readonly acceptanceCriteria: string
}
