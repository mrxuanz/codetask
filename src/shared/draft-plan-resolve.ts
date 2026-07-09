import { isPlanningWorkspaceStatus } from './design-session'
import { isLaunchedJobStatus } from './job-lifecycle'

export interface DraftPlanReference {
  designSessionId: string | null
  launchedJobId: string | null
  activePlanId: string | null
}

/**
 * Resolve draft→plan references for the single-row model.
 * `activePlanId` is the thread_jobs id (linkedPlanId / plan.id).
 * `launchedJobId` is the same id once the plan has left the planning workspace
 * (planConfirmedAt set / status pending|running|terminal).
 */
export function resolveDraftPlanReference(input: {
  linkedPlanId?: string | null
  designSessionId?: string | null
  launchedJobId?: string | null
  planId?: string | null
  planStatus?: string | null
  planConfirmedAt?: number | null
}): DraftPlanReference {
  const linked = input.linkedPlanId?.trim() || null
  const planId = input.planId?.trim() || null
  const explicitLaunched = input.launchedJobId?.trim() || null
  // Legacy field: may still appear on payloads; treat as an alternate plan id.
  const legacySession = input.designSessionId?.trim() || null

  const activePlanId = linked ?? planId ?? legacySession

  const leftPlanningWorkspace =
    input.planConfirmedAt != null ||
    (input.planStatus != null &&
      !isPlanningWorkspaceStatus(input.planStatus) &&
      isLaunchedJobStatus(input.planStatus))

  const launchedJobId =
    explicitLaunched ?? (activePlanId && leftPlanningWorkspace ? activePlanId : null)

  return {
    designSessionId: legacySession,
    launchedJobId,
    activePlanId
  }
}
