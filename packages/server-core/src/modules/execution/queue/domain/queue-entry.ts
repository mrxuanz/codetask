export type QueueEntryStatus = 'queued' | 'claimed' | 'removed'

export type QueueEntry = {
  jobId: string
  generation: number
  status: QueueEntryStatus
  priority: number
  sequence: number
  enqueuedAt: number
  claimedAt: number | null
  removedAt: number | null
}
