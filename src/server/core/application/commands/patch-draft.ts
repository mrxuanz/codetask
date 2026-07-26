import { updateCollectingPayload } from '../../domain/drafts/transitions'
import type { Draft, DraftPayload } from '../../domain/drafts/types'
import type { DraftRepo } from '../ports/repositories'
import type { UnitOfWork } from '../ports/unit-of-work'
import type { IdempotencyStore } from '../idempotency'
import { fail, type CommandResult } from '../results'
import { mapThrownToResult, runInUow, withIdempotency, type CommandBase } from './helpers'

export type PatchDraftCommand = CommandBase & {
  readonly draftId: string
  readonly expectedRevision: number
  readonly content?: string
  readonly payload?: DraftPayload
}

export type PatchDraftDeps = {
  readonly drafts: DraftRepo
  readonly unitOfWork: UnitOfWork
  readonly idempotency: IdempotencyStore
}

export async function patchDraftCommand(
  deps: PatchDraftDeps,
  command: PatchDraftCommand
): Promise<CommandResult<{ draft: Draft }>> {
  return withIdempotency(deps.idempotency, command, () =>
    runInUow(
      deps.unitOfWork,
      async () => {
        const draft = await deps.drafts.get(command.draftId)
        if (!draft) {
          return fail('draft.not_found', `Draft not found: ${command.draftId}`)
        }
        try {
          const next = updateCollectingPayload(draft, {
            ...(command.content !== undefined ? { content: command.content } : {}),
            ...(command.payload !== undefined ? { payload: command.payload } : {})
          })
          await deps.drafts.save(next, { expectedRevision: command.expectedRevision })
          return { ok: true, value: { draft: next } }
        } catch (error: unknown) {
          return mapThrownToResult(error)
        }
      },
      { type: 'draft.patched', aggregateId: command.draftId }
    )
  )
}
