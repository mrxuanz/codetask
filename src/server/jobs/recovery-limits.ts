export const MAX_INFRA_RETRIES = 3
export const MAX_TASK_PREP_GENERATIONS = 3
export const MAX_TASK_REPAIR_GENERATIONS = 3
export const MAX_VERIFIER_INFRA_RETRIES = 3
export const MAX_SM_REPAIR_GENERATIONS = 3
export const MAX_PAUSING_TURN_ATTEMPTS = 3

export function pausingAttemptKey(jobId: string): string {
  return `pausing:${jobId}`
}

/**
 * After the agent turn completes, how long to wait for report_task_result /
 * verifier MCP completion before treating it as a missed hand-in.
 * Mid-turn stall detection is ProgressGuard (TASK_TURN_STALLED_MS = 60min),
 * not this timer — an active turn must not be wall-clock killed here.
 */
export const TASK_EVIDENCE_GRACE_MS = 3 * 60 * 1000
export const VERIFIER_VERDICT_GRACE_MS = 3 * 60 * 1000

/** @deprecated No longer used as a mid-turn wall clock. Prefer TASK_EVIDENCE_GRACE_MS after turn complete. */
export const TASK_EVIDENCE_WAIT_FULL_MS = TASK_EVIDENCE_GRACE_MS
