import type { JobExecutionProfile, SavedJobPlan } from './plan'
import type { JobReferenceManifestDto } from '../job-references'
import type { TurnErrorDto } from './turn-errors'
import type {
  ExecutionProgressDto,
  JobFailureDto,
  JobLifecycle,
  JobRecoveryDto
} from '../job-recovery-state'
import type { JobRecoveryReason, SuspensionKind } from '../job-suspension'
import type {
  ExecutionQueueDto,
  PlanProgressDto,
  TaskProgressDto,
  ThreadJobAbilityDto
} from './jobs'

/** Design planning-session status values used by plan review UI. */
export type PlanningSessionStatus =
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

/**
 * Design/plan UI view of a planning session (or plan-shaped progress).
 * Execution list/detail MUST use JobDetail / ExecutionJob — never this type.
 */
export interface PlanningSessionViewDto {
  id: string
  threadId: string
  draftMessageId: string
  title: string
  summary: string
  status: PlanningSessionStatus
  planProgress: PlanProgressDto
  taskProgress: TaskProgressDto
  abilities: ThreadJobAbilityDto[]
  plan?: SavedJobPlan | null | undefined
  executionProfile?: JobExecutionProfile | undefined
  referenceManifest?: JobReferenceManifestDto | null | undefined

  referenceManifestStale?: boolean | undefined
  workspacePath?: string | undefined
  lastError?: TurnErrorDto | null | undefined

  lifecycle?: JobLifecycle | undefined
  execution?: ExecutionProgressDto | undefined
  failure?: JobFailureDto | undefined
  recovery?: JobRecoveryDto | undefined

  availableActions?: readonly string[] | undefined
  stateRevision?: number | undefined
  queue?: ExecutionQueueDto | undefined

  planRevision?: number | null | undefined
  draftConfirmedAt?: number | null | undefined
  planConfirmedAt?: number | null | undefined

  designSessionId?: string | null | undefined
  snapshotDraftRevision?: number | null | undefined
  snapshotPlanRevision?: number | null | undefined
  snapshotManifestRevision?: number | null | undefined

  suspensionKind?: SuspensionKind | undefined
  continueAfterPause?: boolean | undefined
  recoveryReason?: JobRecoveryReason | undefined

  createdAt: number | string
  updatedAt: number | string
}
