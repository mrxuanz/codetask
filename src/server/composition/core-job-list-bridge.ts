/**
 * Bridge: production GET `/api/jobs` list → dual-read enrichment from new-core.
 *
 * Prefer core-mapped DTOs for ids present in the core store; keep legacy rows
 * for unmigrated ids. When core is empty / unavailable, return legacy unchanged.
 */
import type { ApplicationHandle } from './types'
import { projectJob } from '../core/application/queries/get-job'
import { mapJobToLegacy, type LegacyJobDto } from '../compatibility/legacy-api-mapper'

export type LegacyListJob = {
  readonly id: string
}

/**
 * Map one core job id → legacy job DTO, or null when missing from core.
 */
export async function tryMapCoreJobToLegacy(
  jobId: string,
  core: ApplicationHandle | null | undefined
): Promise<LegacyJobDto | null> {
  if (!core) return null
  const existing = await core.jobs.get(jobId)
  if (!existing) return null
  return mapJobToLegacy(projectJob(existing))
}

/**
 * Enrich a legacy job list with core projections when present (dual-read).
 * Core fields overwrite legacy on shared keys; empty core stubs do not wipe
 * richer legacy display fields (title/summary/threadId/draftMessageId).
 */
export async function enrichUserJobsFromCore<T extends LegacyListJob>(
  jobs: readonly T[],
  core: ApplicationHandle | null | undefined
): Promise<Array<T & Partial<LegacyJobDto>>> {
  if (!core || jobs.length === 0) return [...jobs]

  const enriched: Array<T & Partial<LegacyJobDto>> = []
  for (const job of jobs) {
    const mapped = await tryMapCoreJobToLegacy(job.id, core)
    if (!mapped) {
      enriched.push(job)
      continue
    }
    const legacy = job as T & Partial<LegacyJobDto>
    enriched.push({
      ...legacy,
      ...mapped,
      title: mapped.title || legacy.title || '',
      summary: mapped.summary || legacy.summary || '',
      threadId: mapped.threadId || legacy.threadId || '',
      draftMessageId: mapped.draftMessageId || legacy.draftMessageId || ''
    })
  }
  return enriched
}
