import type { Thread } from '../../core/domain/conversation/types'
import type { ThreadRepo, SaveOptions } from '../../core/application/ports/repositories'
import { RevisionConflictError } from '../../core/application/ports/repositories'

/**
 * Threads have no domain revision; optional expectedRevision is stored alongside
 * as a monotonic counter bumped on each save when not checked.
 */
type StoredThread = {
  thread: Thread
  revision: number
}

export class InMemoryThreadRepo implements ThreadRepo {
  private readonly store = new Map<string, StoredThread>()

  async get(id: string): Promise<Thread | undefined> {
    return this.store.get(id)?.thread
  }

  async save(thread: Thread, options?: SaveOptions): Promise<void> {
    const existing = this.store.get(thread.id)
    if (options?.expectedRevision !== undefined) {
      const current = existing?.revision ?? 0
      if (current !== options.expectedRevision) {
        throw new RevisionConflictError(
          `Thread ${thread.id}: expected revision ${options.expectedRevision}, have ${current}`
        )
      }
    }
    this.store.set(thread.id, {
      thread: { ...thread },
      revision: (existing?.revision ?? 0) + 1
    })
  }

  /** Test helper */
  getRevision(id: string): number | undefined {
    return this.store.get(id)?.revision
  }
}
