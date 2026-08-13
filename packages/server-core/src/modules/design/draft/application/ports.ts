import type { DraftAbility, DraftReference, ExecutionProfile } from '@codetask/contracts'
import type { DraftRecord } from '../domain/draft.ts'

export interface DraftRepository {
  list(input: {
    actorId: string
    q?: string
    completion?: 'all' | 'incomplete' | 'complete'
  }): Promise<DraftRecord[]>
  getById(draftId: string): Promise<DraftRecord | null>
  insert(draft: DraftRecord): Promise<void>
  update(draft: DraftRecord, expectedRevision: number): Promise<DraftRecord>
  updateAbilities(
    draft: DraftRecord,
    expectedRevision: number,
    abilities: DraftAbility[]
  ): Promise<DraftRecord>
  updateReferences(
    draft: DraftRecord,
    expectedRevision: number,
    references: DraftReference[]
  ): Promise<DraftRecord>
  setExecutionProfile(draftId: string, profile: ExecutionProfile | null): Promise<void>
  delete(draftId: string): Promise<void>
  countActivePlanningSessions(draftId: string): Promise<number>
}

export interface ProjectWorkspacePort {
  resolveWorkspaceRoot(input: { actorId: string; projectId: string }): Promise<string>
}

/** Host-owned durable asset lifecycle. Server-core never reaches into the filesystem. */
export interface DraftAssetPort {
  prepareReference(input: {
    actorId: string
    projectId: string
    draftId: string
    reference: DraftReference
  }): DraftReference
  retainReference(draftId: string, reference: DraftReference): void
  commitReference?(draftId: string, reference: DraftReference): void
  releaseReference(draftId: string, reference: DraftReference): void
  releaseDraft(draftId: string): void
}
