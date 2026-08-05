import { isPlanningWorkspaceStatus } from './planning-status.ts'
import { isLaunchedJobStatus } from './job-lifecycle.ts'

export interface DraftPlanReference {
  designSessionId: string | null
  launchedJobId: string | null
  activePlanId: string | null
}

/**
 * Resolve draft→plan references for create-task UI.
 * `activePlanId` is the planning-session id (linkedPlanId / plan.id).
 * `launchedJobId` is the Execution job id once published from planning.
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
