import { memoryDebug } from '../debug/memory'
import {
  cleanupJobRuntimeTreeIfTerminal,
  isDeferredCleanupResult,
  isTerminalJobStatus,
  type CleanupJobRuntimeResult
} from './cleanup'

export type ScheduleRuntimeCleanupResult =
  | CleanupJobRuntimeResult
  | 'skipped_non_terminal'
  | 'failed'

export interface ScheduleRuntimeCleanupInput {
  dataDir: string
  threadId: string
  jobId: string
  status: string
  reason: string
}

/**
 * Unified cleanup entry: every slot-release / terminal path should call this instead of
 * ad-hoc cleanup + error logs for expected deferred outcomes.
 */
export async function scheduleRuntimeCleanup(
  input: ScheduleRuntimeCleanupInput
): Promise<ScheduleRuntimeCleanupResult> {
  if (!isTerminalJobStatus(input.status)) {
    return 'skipped_non_terminal'
  }

  try {
    const result = await cleanupJobRuntimeTreeIfTerminal(
      input.dataDir,
      input.threadId,
      input.jobId,
      input.status
    )
    if (result === 'skipped_non_terminal') {
      return result
    }
    if (isDeferredCleanupResult(result)) {
      memoryDebug('runtime cleanup deferred', {
        jobId: input.jobId,
        reason: input.reason,
        result
      })
      return result
    }
    return result
  } catch (error) {
    console.warn('[jobs] runtime cleanup failed', input.jobId, input.reason, error)
    return 'failed'
  }
}

export function isExpectedCleanupOutcome(
  result: ScheduleRuntimeCleanupResult
): result is CleanupJobRuntimeResult | 'skipped_non_terminal' {
  return result !== 'failed'
}
