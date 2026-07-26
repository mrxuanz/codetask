import { confirmDraft, type Draft } from '../../domain/drafts/index'
import type { DraftRepo } from '../ports/repositories'
import type { UnitOfWork } from '../ports/unit-of-work'
import { fail, type CommandResult } from '../results'
import { mapThrownToResult } from '../commands/helpers'
import {
  assertNotAborted,
  resolveWorkSignal,
  type WorkContext
} from './work-context'

export type FreezeDraftWorkInput = {
  readonly draftId: string
  readonly expectedRevision: number
  readonly signal?: AbortSignal
}

export type FreezeDraftWorkDeps = {
  readonly drafts: DraftRepo
  readonly unitOfWork: UnitOfWork
}

/**
 * Freeze (confirm) a collecting draft. Confirmed drafts cannot be silently mutated.
 */
export async function freezeDraftWork(
  deps: FreezeDraftWorkDeps,
  input: FreezeDraftWorkInput,
  context?: WorkContext
): Promise<CommandResult<{ draft: Draft }>> {
  const signal = resolveWorkSignal(context, input.signal)
  try {
    assertNotAborted(signal)
    return await deps.unitOfWork.run(async (tx) => {
      assertNotAborted(signal)
      const draft = await deps.drafts.get(input.draftId)
      if (!draft) {
        return fail('draft.not_found', `Draft not found: ${input.draftId}`)
      }
      if (draft.status === 'confirmed') {
        return fail('draft.already_confirmed', 'Confirmed draft cannot be frozen again')
      }
      if (draft.status === 'abandoned') {
        return fail('draft.not_collecting', 'Abandoned draft cannot be frozen')
      }
      const confirmed = confirmDraft(draft)
      await deps.drafts.save(confirmed, { expectedRevision: input.expectedRevision })
      tx.enqueueEvent({ type: 'draft.frozen', aggregateId: confirmed.id })
      return { ok: true as const, value: { draft: confirmed } }
    })
  } catch (error: unknown) {
    if (error instanceof Error && (error.name === 'AbortError' || (error as { code?: string }).code === 'work.aborted')) {
      return fail('work.aborted', error.message)
    }
    return mapThrownToResult(error)
  }
}
