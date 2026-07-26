/**
 * Bridge: job SSE snapshots for jobs present in new-core.
 *
 * Builds a legacy hub `job_snapshot` via legacy-sse-mapper + legacy-api-mapper.
 */
import type { ApplicationHandle } from './types'
import { projectJob } from '../core/application/queries/get-job'
import { mapJobToLegacy, type LegacyJobDto } from '../compatibility/legacy-api-mapper'
import {
  mapOutboxEventToLegacyHub,
  type LegacyHubEnvelope
} from '../compatibility/legacy-sse-mapper'

/**
 * When the job exists in core, return a mapper-shaped legacy job DTO for SSE.
 * Otherwise null → caller keeps hub/legacy fallback.
 */
export async function tryCoreJobSseSnapshot(
  jobId: string,
  core: ApplicationHandle | null | undefined
): Promise<LegacyJobDto | null> {
  if (!core) return null
  const existing = await core.jobs.get(jobId)
  if (!existing) return null

  const legacyJob = mapJobToLegacy(projectJob(existing))
  const hub: LegacyHubEnvelope = mapOutboxEventToLegacyHub({
    eventId: existing.stateRevision,
    topic: `job:${jobId}`,
    type: 'job.changed',
    entityId: jobId,
    revision: existing.stateRevision,
    payload: { job: legacyJob }
  })

  const data = hub.data
  if (
    data !== null &&
    typeof data === 'object' &&
    'job' in data &&
    data.job !== null &&
    typeof data.job === 'object'
  ) {
    return data.job as LegacyJobDto
  }
  return legacyJob
}
