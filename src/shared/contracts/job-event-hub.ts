import type { ConversationMessageDto } from './conversation'
import type { JobSseEvent } from './sse'
import type { ThreadDto } from './threads'

export type HubTopic = `job:${string}` | `thread:${string}`

export type ThreadHubEvent =
  | { event: 'thread_snapshot'; data: { thread: ThreadDto } }
  | { event: 'thread_updated'; data: { thread: ThreadDto } }
  | { event: 'draft_updated'; data: { message: ConversationMessageDto } }

export type HubEvent = JobSseEvent | ThreadHubEvent | { event: 'resync'; data: { reason: string } }

export type HubEnvelope = {
  topic: HubTopic
  seq: number
} & HubEvent

/** @deprecated Use HubEnvelope */
export type JobHubEnvelope = HubEnvelope

export interface HubSubscriptionsDto {
  connectionId: string
  topics: HubTopic[]
}

/** @deprecated Use HubSubscriptionsDto */
export interface JobHubSubscriptionsDto {
  jobIds: string[]
}

export function jobTopic(jobId: string): HubTopic {
  return `job:${jobId}`
}

export function threadTopic(threadId: string): HubTopic {
  return `thread:${threadId}`
}

export function parseHubTopic(topic: string): HubTopic | null {
  if (topic.startsWith('job:') && topic.length > 4) return topic as HubTopic
  if (topic.startsWith('thread:') && topic.length > 7) return topic as HubTopic
  return null
}

export function jobIdFromTopic(topic: HubTopic): string | null {
  return topic.startsWith('job:') ? topic.slice(4) : null
}

export function threadIdFromTopic(topic: HubTopic): string | null {
  return topic.startsWith('thread:') ? topic.slice(7) : null
}
