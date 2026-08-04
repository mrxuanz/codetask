export type { JobReferenceManifestDto } from './job-reference.ts'
export type { TaskEvidenceDto } from './ui-evidence.ts'
import type { SliceVerificationRecordDto, TaskBlockerKind, TaskEvidenceDto } from './ui-evidence.ts'

export type PlanProgressDto = {
  phase: 'idle' | 'planning' | 'plan_ready' | 'failed' | 'cleanup_failed' | 'needs_auth'
  status: 'pending' | 'running' | 'completed' | 'failed'
  contextsRegistered: number
  contextsTotal: number
  milestones?: number | undefined
  slices?: number | undefined
  tasks?: number | undefined
  message?: string | null | undefined
  progressCode?: string | null | undefined
  progressParams?: Record<string, unknown> | null | undefined
}

export type TaskProgressItemDto = {
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
  error?: { code: string; message: string } | null | undefined
  providerCode?: string | null | undefined
  /** @deprecated Use providerCode */
  coreCode?: string | null | undefined
}

export type TaskProgressSliceDto = {
  id: string
  runtimeStatus?: string | null | undefined
  verificationStatus?: string | null | undefined
  verdict?: SliceVerificationRecordDto | null | undefined
  verdictArtifactId?: string | null | undefined
  verdictSummary?: string | null | undefined
}

export type TaskProgressMilestoneDto = {
  id: string
  verificationStatus?: string | null | undefined
}

export type TaskProgressDto = {
  phase: 'idle' | 'running' | 'completed' | 'failed'
  status: 'pending' | 'running' | 'completed' | 'failed'
  currentIndex: number
  total: number
  currentTaskId?: string | null | undefined
  message?: string | null | undefined
  progressCode?: string | null | undefined
  progressParams?: Record<string, unknown> | null | undefined
  tasks: TaskProgressItemDto[]
  slices?: TaskProgressSliceDto[] | undefined
  milestones?: TaskProgressMilestoneDto[] | undefined
  repairGenerations?: Record<string, number> | undefined
  verificationAttempts?: Record<string, number> | undefined
  verificationBundleHashes?: Record<string, string> | undefined
}

export type JobAbilityDto = {
  abilityCode: string
  label?: string | undefined
  recommendedCoreCode?: string | undefined
}

/** @deprecated Use JobAbilityDto — legacy thread_jobs naming. */
export type ThreadJobAbilityDto = JobAbilityDto

export type ExecutionQueueDto = {
  position: number | null
  ahead: number
}

export type ThreadDraftSummaryDto = {
  /** @deprecated Prefer draftId */
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

export type UserDraftListItemDto = {
  /** @deprecated Prefer draftId */
  messageId: string
  draftId: string
  title: string
  summary: string
  status: string
  linkedPlanId: string | null
  createdAt: string
  collecting?: boolean
  plan?: { id: string; status: string; title: string } | null
  /** @deprecated Conversation ownership is via projectId; empty when unknown */
  threadId?: string
  projectId: string
  projectTitle: string
  /** @deprecated */
  threadTitle?: string
  launched: boolean
  jobId: string | null
}

/** Minimal plan tree node used by draft/plan UI helpers. */
export type UiFlatTaskPlan = {
  id?: string
  title?: string
  status?: string
  milestones?: unknown[]
  [key: string]: unknown
}
