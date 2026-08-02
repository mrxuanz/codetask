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
  replaceAbilities(draftId: string, abilities: DraftAbility[]): Promise<void>
  replaceReferences(draftId: string, references: DraftReference[]): Promise<void>
  setExecutionProfile(draftId: string, profile: ExecutionProfile | null): Promise<void>
  delete(draftId: string): Promise<void>
  countActivePlanningSessions(draftId: string): Promise<number>
}

export interface ProjectWorkspacePort {
  resolveWorkspaceRoot(input: { actorId: string; projectId: string }): Promise<string>
}
