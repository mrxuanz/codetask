import type { HubEvent, HubTopic } from '@shared/contracts/job-event-hub'
import type { JobSseEvent } from '../jobs/types'

const MAX_QUEUE_EVENTS = 64

const PRIORITY_EVENTS = new Set<string>(['job_done', 'error', 'job_snapshot', 'resync'])

function isCoalescableTaskProgress(event: HubEvent): boolean {
  return event.event === 'task_progress'
}

export function enqueueJobSseEvent(queue: JobSseEvent[], event: JobSseEvent): void {
  enqueueHubEvent(queue, event)
}

export function enqueueHubEvent(queue: HubEvent[], event: HubEvent): void {
  if (isCoalescableTaskProgress(event)) {
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (isCoalescableTaskProgress(queue[i])) {
        queue[i] = event
        return
      }
    }
    queue.push(event)
    trimHubQueue(queue)
    return
  }

  queue.push(event)
  trimHubQueue(queue)
}

function trimHubQueue(queue: HubEvent[]): void {
  while (queue.length > MAX_QUEUE_EVENTS) {
    const dropIndex = queue.findIndex((event) => !PRIORITY_EVENTS.has(event.event))
    if (dropIndex < 0) break
    queue.splice(dropIndex, 1)
  }
}

/** Topic-keyed fanout bus (job:* and thread:*). Kept as JobEventBus for AppContext compat. */
export class JobEventBus {
  private readonly listeners = new Map<string, Set<(event: HubEvent) => void>>()

  emit(topic: HubTopic | string, event: HubEvent): void {
    const set = this.listeners.get(topic)
    if (!set) return
    for (const listener of set) {
      listener(event)
    }
  }

  subscribe(topic: HubTopic | string, listener: (event: HubEvent) => void): () => void {
    const set = this.listeners.get(topic) ?? new Set()
    set.add(listener)
    this.listeners.set(topic, set)
    return () => {
      const current = this.listeners.get(topic)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) {
        this.listeners.delete(topic)
      }
    }
  }

  clearTopic(topic: HubTopic | string): void {
    this.listeners.delete(topic)
  }

  /** @deprecated Use clearTopic */
  clearJob(jobId: string): void {
    this.clearTopic(`job:${jobId}`)
  }
}
