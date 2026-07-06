import type { JobSseEvent } from '../jobs/types'

const MAX_QUEUE_EVENTS = 64

const PRIORITY_EVENTS = new Set<JobSseEvent['event']>(['job_done', 'error', 'job_snapshot'])

function isCoalescableTaskProgress(event: JobSseEvent): boolean {
  return event.event === 'task_progress'
}

export function enqueueJobSseEvent(queue: JobSseEvent[], event: JobSseEvent): void {
  if (isCoalescableTaskProgress(event)) {
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (isCoalescableTaskProgress(queue[i])) {
        queue[i] = event
        return
      }
    }
    queue.push(event)
    trimJobSseQueue(queue)
    return
  }

  queue.push(event)
  trimJobSseQueue(queue)
}

function trimJobSseQueue(queue: JobSseEvent[]): void {
  while (queue.length > MAX_QUEUE_EVENTS) {
    const dropIndex = queue.findIndex((event) => !PRIORITY_EVENTS.has(event.event))
    if (dropIndex < 0) break
    queue.splice(dropIndex, 1)
  }
}

export class JobEventBus {
  private readonly listeners = new Map<string, Set<(event: JobSseEvent) => void>>()

  emit(jobId: string, event: JobSseEvent): void {
    const set = this.listeners.get(jobId)
    if (!set) return
    for (const listener of set) {
      listener(event)
    }
  }

  subscribe(jobId: string, listener: (event: JobSseEvent) => void): () => void {
    const set = this.listeners.get(jobId) ?? new Set()
    set.add(listener)
    this.listeners.set(jobId, set)
    return () => {
      const current = this.listeners.get(jobId)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) {
        this.listeners.delete(jobId)
      }
    }
  }

  clearJob(jobId: string): void {
    this.listeners.delete(jobId)
  }
}
