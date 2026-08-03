import type { JobReferenceManifestDto } from '../job-references'
import type { SliceVerificationRecordDto, TaskBlockerKind, TaskEvidenceDto } from './evidence'
import type { TurnErrorDto } from './turn-errors'
import type { JobProgressCode, JobProgressParams } from '../progress-codes'

export type { SliceVerificationRecordDto, TaskEvidenceDto } from './evidence'
export type { JobRecoveryReason, SuspensionKind } from '../job-suspension'

export interface PlanProgressDto {
  phase: 'idle' | 'planning' | 'plan_ready' | 'failed' | 'cleanup_failed' | 'needs_auth'
  status: 'pending' | 'running' | 'completed' | 'failed'
  contextsRegistered: number
  contextsTotal: number
  milestones?: number | undefined
  slices?: number | undefined
  tasks?: number | undefined
  message?: string | null | undefined

  progressCode?: JobProgressCode | null | undefined
  progressParams?: JobProgressParams | null | undefined
}

export interface TaskProgressItemDto {
  id: string
  title: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped'
  abilityCode?: string | undefined
  executionStatus?: string | null | undefined
  evidenceStatus?: string | null | undefined
  evidence?: TaskEvidenceDto | null | undefined

  evidenceArtifactId?: string | null | undefined

  evidenceSummary?: string | null | undefined
  blockerKind?: TaskBlockerKind | null | undefined
  recoveryAction?: string | null | undefined

  errorMessage?: string | null | undefined
  error?: TurnErrorDto | null | undefined
  coreCode?: string | null | undefined
}

export interface TaskProgressSliceDto {
  id: string
  runtimeStatus?: string | null | undefined
  verificationStatus?: string | null | undefined
  verdict?: SliceVerificationRecordDto | null | undefined
  verdictArtifactId?: string | null | undefined
  verdictSummary?: string | null | undefined
}

export interface TaskProgressMilestoneDto {
  id: string
  verificationStatus?: string | null | undefined
}

export interface TaskProgressDto {
  phase: 'idle' | 'running' | 'completed' | 'failed'
  status: 'pending' | 'running' | 'completed' | 'failed'
  currentIndex: number
  total: number
  currentTaskId?: string | null | undefined
  message?: string | null | undefined

  progressCode?: JobProgressCode | null | undefined
  progressParams?: JobProgressParams | null | undefined
  tasks: TaskProgressItemDto[]
  slices?: TaskProgressSliceDto[] | undefined
  milestones?: TaskProgressMilestoneDto[] | undefined
  repairGenerations?: Record<string, number> | undefined
  verificationAttempts?: Record<string, number> | undefined
  verificationBundleHashes?: Record<string, string> | undefined
}

export interface JobAbilityDto {
  abilityCode: string
  label?: string | undefined
  recommendedCoreCode?: string | undefined
}

/** @deprecated Use JobAbilityDto — legacy thread_jobs naming. */
export type ThreadJobAbilityDto = JobAbilityDto

export type { PlanningSessionStatus } from './planning-session-view'

export interface ExecutionQueueDto {
  /** 1-based position in the user's pending FIFO queue; null when not queued. */
  position: number | null
  /** How many pending jobs are ahead of this one. */
  ahead: number
}

export type { PlanningSessionViewDto } from './planning-session-view'

export interface ThreadDraftSummaryDto {
  messageId: string
  draftId: string
  title: string
  summary: string
  status: string
  linkedPlanId: string | null
  designSessionId?: string | null
  launchedJobId?: string | null
  createdAt: string
  collecting?: boolean
  plan?: { id: string; status: string; title: string } | null
}

export interface UserDraftListItemDto {
  messageId: string
  draftId: string
  title: string
  summary: string
  status: string
  linkedPlanId: string | null
  createdAt: string
  collecting?: boolean
  plan?: { id: string; status: string; title: string } | null
  threadId: string
  projectId: string
  projectTitle: string
  threadTitle: string
  launched: boolean
  jobId: string | null
}

export type { JobReferenceManifestDto }
