import type { Thread } from '../../domain/conversation/types'
import type { ThreadRepo } from '../ports/repositories'
import { fail, type QueryResult } from '../results'

export type ThreadProjection = {
  readonly id: string
  readonly projectId: string
  readonly ownerUserId: string
  readonly draftId: string | null
  readonly planId: string | null
  readonly jobId: string | null
}

export function projectThread(thread: Thread): ThreadProjection {
  return {
    id: thread.id,
    projectId: thread.projectId,
    ownerUserId: thread.ownerUserId,
    draftId: thread.draftId,
    planId: thread.planId,
    jobId: thread.jobId
  }
}

export async function getThreadQuery(
  deps: { readonly threads: ThreadRepo },
  input: { readonly threadId: string }
): Promise<QueryResult<ThreadProjection>> {
  const thread = await deps.threads.get(input.threadId)
  if (!thread) {
    return fail('thread.not_found', `Thread not found: ${input.threadId}`)
  }
  return { ok: true, value: projectThread(thread) }
}
