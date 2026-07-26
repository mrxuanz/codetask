import type { RetainedArtifact } from '../../core/domain/retention/types'
import type { RetentionStore } from '../../core/application/ports/retention-store'

export class InMemoryRetentionStore implements RetentionStore {
  private readonly store = new Map<string, RetainedArtifact>()

  async list(): Promise<readonly RetainedArtifact[]> {
    return [...this.store.values()].map((a) => ({ ...a }))
  }

  async save(artifact: RetainedArtifact): Promise<void> {
    this.store.set(artifact.id, { ...artifact })
  }

  async markDeleted(id: string, deletedAtMs: number): Promise<void> {
    const existing = this.store.get(id)
    if (!existing) return
    this.store.set(id, { ...existing, deletedAtMs })
  }

  async get(id: string): Promise<RetainedArtifact | undefined> {
    const row = this.store.get(id)
    return row ? { ...row } : undefined
  }
}
