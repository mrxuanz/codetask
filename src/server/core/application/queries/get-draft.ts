import type { Draft, DraftPayload } from '../../domain/drafts/types'
import type { DraftRepo } from '../ports/repositories'
import { fail, type QueryResult } from '../results'

export type DraftProjection = {
  readonly id: string
  readonly status: Draft['status']
  readonly revision: number
  readonly content: string
  readonly projectId: string
  readonly threadId: string
  readonly payload?: DraftPayload
}

export function projectDraft(draft: Draft): DraftProjection {
  return {
    id: draft.id,
    status: draft.status,
    revision: draft.revision,
    content: draft.content,
    projectId: draft.projectId,
    threadId: draft.threadId,
    ...(draft.payload !== undefined ? { payload: draft.payload } : {})
  }
}

export async function getDraftQuery(
  deps: { readonly drafts: DraftRepo },
  input: { readonly draftId: string }
): Promise<QueryResult<DraftProjection>> {
  const draft = await deps.drafts.get(input.draftId)
  if (!draft) {
    return fail('draft.not_found', `Draft not found: ${input.draftId}`)
  }
  return { ok: true, value: projectDraft(draft) }
}
