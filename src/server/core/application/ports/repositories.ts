import type { Thread } from '../../domain/conversation/types'
import type { Draft } from '../../domain/drafts/types'
import type { Plan } from '../../domain/plans/types'
import type { Job } from '../../domain/jobs/types'

export class RevisionConflictError extends Error {
  readonly code = 'revision.conflict' as const

  constructor(message?: string) {
    super(message ?? 'Stale revision on save')
    this.name = 'RevisionConflictError'
  }
}

export interface SaveOptions {
  /** When set, save fails with RevisionConflictError if stored revision differs. */
  readonly expectedRevision?: number
}

export interface ThreadRepo {
  get(id: string): Promise<Thread | undefined>
  save(thread: Thread, options?: SaveOptions): Promise<void>
}

export interface DraftRepo {
  get(id: string): Promise<Draft | undefined>
  save(draft: Draft, options?: SaveOptions): Promise<void>
}

export interface PlanRepo {
  get(id: string): Promise<Plan | undefined>
  save(plan: Plan, options?: SaveOptions): Promise<void>
}

export interface JobRepo {
  get(id: string): Promise<Job | undefined>
  save(job: Job, options?: SaveOptions): Promise<void>
}
