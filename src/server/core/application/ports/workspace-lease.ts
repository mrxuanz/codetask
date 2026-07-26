export interface WorkspaceLease {
  readonly workspaceId: string
  /** Job (or run) currently holding the exclusive writer lock. */
  readonly holderId: string
  readonly acquiredAtMs: number
}

export interface WorkspaceLeaseRepo {
  get(workspaceId: string): Promise<WorkspaceLease | undefined>
  /**
   * Acquire if free or already held by holderId.
   * Returns false when another holder owns the lease.
   */
  tryAcquire(lease: WorkspaceLease): Promise<boolean>
  release(workspaceId: string, holderId: string): Promise<void>
  /** Drop leases older than maxAgeMs; returns count cleared. */
  clearStale(nowMs: number, maxAgeMs: number): Promise<number>
  listAll(): Promise<readonly WorkspaceLease[]>
}
