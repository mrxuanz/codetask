import type {
  WorkspaceLease,
  WorkspaceLeaseRepo
} from '../../core/application/ports/workspace-lease'

export class InMemoryWorkspaceLeaseRepo implements WorkspaceLeaseRepo {
  private readonly store = new Map<string, WorkspaceLease>()

  async get(workspaceId: string): Promise<WorkspaceLease | undefined> {
    const lease = this.store.get(workspaceId)
    return lease ? { ...lease } : undefined
  }

  async tryAcquire(lease: WorkspaceLease): Promise<boolean> {
    const existing = this.store.get(lease.workspaceId)
    if (existing && existing.holderId !== lease.holderId) {
      return false
    }
    this.store.set(lease.workspaceId, { ...lease })
    return true
  }

  async release(workspaceId: string, holderId: string): Promise<void> {
    const existing = this.store.get(workspaceId)
    if (existing && existing.holderId === holderId) {
      this.store.delete(workspaceId)
    }
  }

  async clearStale(nowMs: number, maxAgeMs: number): Promise<number> {
    let cleared = 0
    for (const [id, lease] of this.store) {
      if (nowMs - lease.acquiredAtMs > maxAgeMs) {
        this.store.delete(id)
        cleared += 1
      }
    }
    return cleared
  }

  async listAll(): Promise<readonly WorkspaceLease[]> {
    return [...this.store.values()].map((l) => ({ ...l }))
  }
}
