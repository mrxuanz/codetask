export type WorkspaceLeaseStatus = 'active' | 'released' | 'expired'

export type WorkspaceLease = {
  id: string
  canonicalWorkspaceRoot: string
  ownerType: string
  ownerId: string
  runId: string | null
  status: WorkspaceLeaseStatus
  leaseOwner: string
  leaseExpiresAt: number
  createdAt: number
  releasedAt: number | null
}
