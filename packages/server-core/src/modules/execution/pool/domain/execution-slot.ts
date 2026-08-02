export type ExecutionSlotStatus = 'free' | 'claimed'

export type ExecutionSlot = {
  pool: string
  slotNumber: number
  runId: string | null
  status: ExecutionSlotStatus
  leaseOwner: string | null
  leaseExpiresAt: number | null
  claimedAt: number | null
  releasedAt: number | null
}
