import type { Job } from '../../core/domain/jobs/types'
import type { JobRepo, SaveOptions } from '../../core/application/ports/repositories'
import { RevisionConflictError } from '../../core/application/ports/repositories'

export class InMemoryJobRepo implements JobRepo {
  private readonly store = new Map<string, Job>()

  async get(id: string): Promise<Job | undefined> {
    const job = this.store.get(id)
    return job ? { ...job } : undefined
  }

  async save(job: Job, options?: SaveOptions): Promise<void> {
    if (options?.expectedRevision !== undefined) {
      const existing = this.store.get(job.id)
      const current = existing?.stateRevision ?? 0
      if (current !== options.expectedRevision) {
        throw new RevisionConflictError(
          `Job ${job.id}: expected revision ${options.expectedRevision}, have ${current}`
        )
      }
    }
    this.store.set(job.id, { ...job })
  }
}
