declare const threadIdBrand: unique symbol
declare const projectIdBrand: unique symbol
declare const userIdBrand: unique symbol

export type ThreadId = string & { readonly [threadIdBrand]: typeof threadIdBrand }
export type ProjectId = string & { readonly [projectIdBrand]: typeof projectIdBrand }
export type UserId = string & { readonly [userIdBrand]: typeof userIdBrand }

export function asThreadId(value: string): ThreadId {
  return value as ThreadId
}

export function asProjectId(value: string): ProjectId {
  return value as ProjectId
}

export function asUserId(value: string): UserId {
  return value as UserId
}

/**
 * Thread aggregate: conversation ownership + current Draft/Plan/Job pointers.
 * Does not run providers or derive Job state.
 * @see 重构.md §5.3 Thread
 */
export interface Thread {
  readonly id: ThreadId
  readonly projectId: ProjectId
  readonly ownerUserId: UserId
  readonly draftId: string | null
  readonly planId: string | null
  readonly jobId: string | null
}

export type ThreadPointers = Pick<Thread, 'draftId' | 'planId' | 'jobId'>

export function createThread(input: {
  readonly id: ThreadId
  readonly projectId: ProjectId
  readonly ownerUserId: UserId
  readonly draftId?: string | null
  readonly planId?: string | null
  readonly jobId?: string | null
}): Thread {
  return {
    id: input.id,
    projectId: input.projectId,
    ownerUserId: input.ownerUserId,
    draftId: input.draftId ?? null,
    planId: input.planId ?? null,
    jobId: input.jobId ?? null
  }
}

export function withThreadPointers(
  thread: Thread,
  pointers: Partial<ThreadPointers>
): Thread {
  return {
    ...thread,
    draftId: pointers.draftId !== undefined ? pointers.draftId : thread.draftId,
    planId: pointers.planId !== undefined ? pointers.planId : thread.planId,
    jobId: pointers.jobId !== undefined ? pointers.jobId : thread.jobId
  }
}
