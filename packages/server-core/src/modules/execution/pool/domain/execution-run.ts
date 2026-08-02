export type ExecutionRunStatus = 'active' | 'stopping' | 'released' | 'failed' | 'interrupted'

export type ExecutionRun = {
  id: string
  jobId: string
  generation: number
  status: ExecutionRunStatus
  leaseOwner: string
  leaseExpiresAt: number
  fencingToken: number
  runtimeRefJson: string | null
  startedAt: number
  updatedAt: number
  releasedAt: number | null
  releaseReason: string | null
}
