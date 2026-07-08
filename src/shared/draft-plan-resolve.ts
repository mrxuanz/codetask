import { isDesignSessionId } from './design-session'

export interface DraftPlanReference {
  designSessionId: string | null
  launchedJobId: string | null
  activePlanId: string | null
}

export function resolveDraftPlanReference(input: {
  linkedPlanId?: string | null
  designSessionId?: string | null
  launchedJobId?: string | null
  planId?: string | null
}): DraftPlanReference {
  const linked = input.linkedPlanId?.trim() || null
  const explicitSession = input.designSessionId?.trim() || null
  const explicitLaunched = input.launchedJobId?.trim() || null
  const planId = input.planId?.trim() || null

  const designSessionId =
    (explicitSession && isDesignSessionId(explicitSession) ? explicitSession : null) ??
    (planId && isDesignSessionId(planId) ? planId : null) ??
    (linked && isDesignSessionId(linked) ? linked : null)

  const launchedJobId =
    (explicitLaunched && !isDesignSessionId(explicitLaunched) ? explicitLaunched : null) ??
    (linked && !isDesignSessionId(linked) ? linked : null)

  const activePlanId = launchedJobId ?? designSessionId ?? linked ?? planId

  return { designSessionId, launchedJobId, activePlanId }
}
