import type { JobSseEvent } from './sse'

export interface JobHubEnvelope {
  jobId: string
  payload: JobSseEvent
}

export interface JobHubSubscriptionsDto {
  jobIds: string[]
}
