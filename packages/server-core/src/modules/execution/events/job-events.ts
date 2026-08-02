import type { ExecutionEventName } from '@codetask/contracts'

export type ExecutionOutboxEvent = {
  id: string
  jobId: string
  eventType: ExecutionEventName | string
  payloadJson: string
  createdAt: number
  dispatchedAt: number | null
  attempts: number
  lastErrorJson: string | null
}

export function jobEventTopic(jobId: string): string {
  return `job:${jobId}`
}
