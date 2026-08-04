import type { JobReferenceManifestDto } from './job-reference.ts'
import type {
  ExecutionQueueDto,
  JobAbilityDto,
  PlanProgressDto,
  TaskProgressDto
} from './ui-jobs.ts'

export type UiPlanningSessionStatus =
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
 * Design/plan UI view. Execution list/detail must use JobDetail — never this type.
 */
export type PlanningSessionViewDto = {
  id: string
  /** @deprecated Conversation linkage is via draft/project; omit when unknown */
  threadId?: string
  draftMessageId: string
  title: string
  summary: string
  status: UiPlanningSessionStatus
  planProgress: PlanProgressDto
  taskProgress: TaskProgressDto
  abilities: JobAbilityDto[]
  plan?: unknown | null | undefined
  executionProfile?: unknown | undefined
  referenceManifest?: JobReferenceManifestDto | null | undefined
  referenceManifestStale?: boolean | undefined
  workspaceRoot?: string | undefined
  /** @deprecated Prefer workspaceRoot */
  workspacePath?: string | undefined
  lastError?: { code: string; message: string } | null | undefined
  lifecycle?: string | undefined
  execution?: unknown | undefined
  failure?: unknown | undefined
  recovery?: unknown | undefined
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
  suspensionKind?: string | undefined
  continueAfterPause?: boolean | undefined
  recoveryReason?: string | undefined
  createdAt: number | string
  updatedAt: number | string
}

export function toPlanningSessionStatus(status: string): UiPlanningSessionStatus {
  if (status === 'ready_to_publish') return 'plan_editing'
  if (status === 'queued') return 'planning'
  if (status === 'published') return 'pending'
  switch (status) {
    case 'pending':
    case 'planning':
    case 'plan_editing':
    case 'plan_confirmed':
    case 'plan_ready':
    case 'running':
    case 'pausing':
    case 'paused':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return status
    default:
      return 'planning'
  }
}

/** Legacy UI planning status name used by job progress/recovery helpers. */
export type PlanningSessionViewStatus = UiPlanningSessionStatus
