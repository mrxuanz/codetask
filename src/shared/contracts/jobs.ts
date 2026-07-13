import type { SavedJobPlan } from './plan'
import type { JobReferenceManifestDto } from '../job-references'
import type { SliceVerificationRecordDto, TaskBlockerKind, TaskEvidenceDto } from './evidence'
import type { TurnErrorDto } from './turn-errors'
import type {
  ExecutionProgressDto,
  JobFailureDto,
  JobLifecycle,
  JobRecoveryDto
} from '../job-recovery-state'
import type { JobProgressCode, JobProgressParams } from '../progress-codes'

export type { SliceVerificationRecordDto, TaskEvidenceDto } from './evidence'

export interface PlanProgressDto {
  phase: 'idle' | 'planning' | 'plan_ready' | 'failed' | 'cleanup_failed' | 'needs_auth'
  status: 'pending' | 'running' | 'completed' | 'failed'
  contextsRegistered: number
  contextsTotal: number
  milestones?: number
  slices?: number
  tasks?: number
  message?: string | null

  progressCode?: JobProgressCode | null
  progressParams?: JobProgressParams | null
}

export interface TaskProgressItemDto {
  id: string
  title: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped'
  abilityCode?: string
  executionStatus?: string | null
  evidenceStatus?: string | null
  evidence?: TaskEvidenceDto | null

  evidenceArtifactId?: string | null

  evidenceSummary?: string | null
  blockerKind?: TaskBlockerKind | null
  recoveryAction?: string | null

  errorMessage?: string | null
  error?: TurnErrorDto | null
  coreCode?: string | null
}

export interface TaskProgressSliceDto {
  id: string
  runtimeStatus?: string | null
  verificationStatus?: string | null
  verdict?: SliceVerificationRecordDto | null
  verdictArtifactId?: string | null
  verdictSummary?: string | null
}

export interface TaskProgressMilestoneDto {
  id: string
  verificationStatus?: string | null
}

export interface TaskProgressDto {
  phase: 'idle' | 'running' | 'completed' | 'failed'
  status: 'pending' | 'running' | 'completed' | 'failed'
  currentIndex: number
  total: number
  currentTaskId?: string | null
  message?: string | null

  progressCode?: JobProgressCode | null
  progressParams?: JobProgressParams | null
  tasks: TaskProgressItemDto[]
  slices?: TaskProgressSliceDto[]
  milestones?: TaskProgressMilestoneDto[]
  repairGenerations?: Record<string, number>
  verificationAttempts?: Record<string, number>
  verificationBundleHashes?: Record<string, string>
}

export interface ThreadJobAbilityDto {
  abilityCode: string
  label?: string
  recommendedCoreCode?: string
}

export type ThreadJobStatus =
  | 'pending'
  | 'planning'
  | 'plan_editing'
  | 'plan_confirmed'
  | 'plan_ready'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface ExecutionQueueDto {
  /** 1-based position in the user's pending FIFO queue; null when not queued. */
  position: number | null
  /** How many pending jobs are ahead of this one. */
  ahead: number
}

export interface ThreadJobDto {
  id: string
  threadId: string
  draftMessageId: string
  title: string
  summary: string
  status: ThreadJobStatus
  planProgress: PlanProgressDto
  taskProgress: TaskProgressDto
  abilities: ThreadJobAbilityDto[]
  plan?: SavedJobPlan | null
  referenceManifest?: JobReferenceManifestDto | null

  referenceManifestStale?: boolean
  workspacePath?: string
  lastError?: TurnErrorDto | null

  lifecycle?: JobLifecycle

  execution?: ExecutionProgressDto

  failure?: JobFailureDto

  recovery?: JobRecoveryDto

  /**
   * Server-authoritative actions. Legacy recovery may emit JobAvailableAction;
   * control-plane jobs attach V3 JobAction values from JobQueryService.
   */
  availableActions?: readonly string[]

  /** Present when a control_jobs row exists (V3 aggregate revision). */
  stateRevision?: number

  /** Present when status is `pending` and the job is in the execution FIFO queue. */
  queue?: ExecutionQueueDto

  planRevision?: number | null
  draftConfirmedAt?: number | null
  planConfirmedAt?: number | null

  designSessionId?: string | null
  snapshotDraftRevision?: number | null
  snapshotPlanRevision?: number | null
  snapshotManifestRevision?: number | null
  createdAt: number
  updatedAt: number
}

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
