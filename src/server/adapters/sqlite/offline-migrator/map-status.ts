import type { JobStatus } from '../../../core/domain/jobs/types'
import { UnmappableLegacyRowError } from './types'

/**
 * Map legacy `thread_jobs.status` into domain {@link JobStatus}.
 * Unknown values fail closed (throw) — never silently coerce.
 */
export function mapLegacyJobStatus(status: string): JobStatus {
  const normalized = status.trim().toLowerCase()
  switch (normalized) {
    case 'pending':
    case 'queued':
    case 'ready':
      return 'queued'
    case 'running':
    case 'executing':
      return 'running'
    case 'pausing':
      return 'pausing'
    case 'paused':
      return 'paused'
    case 'verification':
    case 'verifying':
      return 'verification'
    case 'completed':
    case 'success':
    case 'succeeded':
    case 'done':
      return 'completed'
    case 'failed':
    case 'error':
      return 'failed'
    case 'cancelled':
    case 'canceled':
      return 'cancelled'
    default:
      throw new UnmappableLegacyRowError(`Unmappable legacy job status: ${status}`, {
        status
      })
  }
}
