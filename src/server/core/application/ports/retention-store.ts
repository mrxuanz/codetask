import type { RetainedArtifact } from '../../domain/retention/types'

export interface RetentionStore {
  list(): Promise<readonly RetainedArtifact[]>
  save(artifact: RetainedArtifact): Promise<void>
  /** Soft-delete (sets deletedAtMs). */
  markDeleted(id: string, deletedAtMs: number): Promise<void>
  get(id: string): Promise<RetainedArtifact | undefined>
}
