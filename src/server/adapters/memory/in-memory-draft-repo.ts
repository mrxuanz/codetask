import type { Draft } from '../../core/domain/drafts/types'
import type { DraftRepo, SaveOptions } from '../../core/application/ports/repositories'
import { RevisionConflictError } from '../../core/application/ports/repositories'

export class InMemoryDraftRepo implements DraftRepo {
  private readonly store = new Map<string, Draft>()

  async get(id: string): Promise<Draft | undefined> {
    const draft = this.store.get(id)
    if (!draft) return undefined
    return {
      ...draft,
      ...(draft.payload !== undefined
        ? { payload: { ...draft.payload, sections: draft.payload.sections ? { ...draft.payload.sections } : undefined } }
        : {})
    }
  }

  async save(draft: Draft, options?: SaveOptions): Promise<void> {
    if (options?.expectedRevision !== undefined) {
      const existing = this.store.get(draft.id)
      const current = existing?.revision ?? 0
      if (current !== options.expectedRevision) {
        throw new RevisionConflictError(
          `Draft ${draft.id}: expected revision ${options.expectedRevision}, have ${current}`
        )
      }
    }
    this.store.set(draft.id, {
      ...draft,
      ...(draft.payload !== undefined
        ? {
            payload: {
              ...draft.payload,
              ...(draft.payload.sections !== undefined
                ? { sections: { ...draft.payload.sections } }
                : {})
            }
          }
        : {})
    })
  }
}
