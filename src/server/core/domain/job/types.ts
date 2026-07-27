import type { SupportedCoreCode } from '../../../../shared/providers/codes'
import type { ExecutionTree } from '../draft'

export const JOB_STATES = [
  'queued',
  'running',
  'pause_requested',
  'paused',
  'succeeded',
  'failed',
  'deleted'
] as const

export type JobState = (typeof JOB_STATES)[number]

export const JOB_ITEM_KINDS = [
  'work',
  'work_validation',
  'slice_validation',
  'milestone_validation'
] as const

export type JobItemKind = (typeof JOB_ITEM_KINDS)[number]
export type JobItemState = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped'

export interface JobRoleSettings {
  readonly provider: SupportedCoreCode
  readonly prompt: string
  readonly skillsManual: string
}

export interface JobSettings {
  readonly maxConcurrentJobs: 1 | 2
  readonly work: JobRoleSettings
  readonly workValidation: JobRoleSettings & { readonly enabled: boolean }
  readonly sliceValidation: JobRoleSettings & { readonly enabled: boolean }
  readonly milestoneValidation: JobRoleSettings & { readonly enabled: boolean }
  readonly revision: number
  readonly updatedAtMs: number
}

export interface WorkResult {
  readonly status: 'completed'
  readonly summary: string
  readonly changedFiles: readonly string[]
  readonly evidence: readonly string[]
}

export interface RepairTask {
  readonly title: string
  readonly objective: string
  readonly files: readonly string[]
  readonly acceptanceCriteria: readonly string[]
}

export interface VerificationResult {
  readonly status: 'passed' | 'repair' | 'failed'
  readonly summary: string
  readonly evidence: readonly string[]
  readonly repairTasks: readonly RepairTask[]
}

export interface JobSnapshot {
  readonly id: string
  readonly workspaceId: string
  readonly title: string
  readonly summary: string
  readonly workspace: {
    readonly id: string
    readonly title: string
    readonly rootPath: string
  }
  readonly sourceDraft: {
    readonly title: string
    readonly objective: string
    readonly requirements: string
    readonly constraints: string
    readonly acceptanceCriteria: string
  }
  readonly executionTree: ExecutionTree
  readonly attachments: readonly {
    readonly id: string
    readonly sourceAttachmentId: string
    readonly displayName: string
    readonly mediaType: string
    readonly sizeBytes: number
  }[]
  readonly state: JobState
  readonly revision: number
  readonly queuePosition: number | null
  readonly activeItemId: string | null
  readonly completedItems: number
  readonly totalItems: number
  readonly lastError: { readonly code: string; readonly message: string } | null
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly startedAtMs: number | null
  readonly finishedAtMs: number | null
  readonly items: readonly JobItemSnapshot[]
}

export interface JobItemSnapshot {
  readonly id: string
  readonly sequence: number
  readonly kind: JobItemKind
  readonly treeTaskId: string | null
  readonly scopeId: string
  readonly parentItemId: string | null
  readonly title: string
  readonly objective: string
  readonly files: readonly string[]
  readonly acceptanceCriteria: readonly string[]
  readonly attachmentIds: readonly string[]
  readonly state: JobItemState
  readonly attempt: number
  readonly repairGeneration: number
  readonly provider: SupportedCoreCode
  readonly result: WorkResult | VerificationResult | null
  readonly error: { readonly code: string; readonly message: string } | null
  readonly startedAtMs: number | null
  readonly finishedAtMs: number | null
}
