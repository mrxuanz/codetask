/**
 * Realtime topic ownership helpers (06).
 * Used only to authorize topic subscription — never pushes business snapshots on subscribe.
 */
import { getAppContext } from '../bootstrap'

/** Resolve an actor-owned Execution job for realtime topic authorization. */
export async function getOwnedRealtimeJob(
  actorId: string,
  jobId: string
): Promise<import('@codetask/contracts').JobDetail | null> {
  try {
    const { getOrComposeExecution } = await import('../design-module')
    const execution = getOrComposeExecution(getAppContext())
    return execution.jobs.query.get({ userId: actorId, sessionId: '' }, jobId)
  } catch {
    return null
  }
}
