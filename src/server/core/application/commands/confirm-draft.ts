import { confirmDraft } from '../../domain/drafts/transitions'
import type { Draft } from '../../domain/drafts/types'
import type { DraftRepo } from '../ports/repositories'
import type { UnitOfWork } from '../ports/unit-of-work'
import type { IdempotencyStore } from '../idempotency'
import { fail, type CommandResult } from '../results'
import { mapThrownToResult, runInUow, withIdempotency, type CommandBase } from './helpers'

export type ConfirmDraftCommand = CommandBase & {
  readonly draftId: string
  readonly expectedRevision: number
}

export type ConfirmDraftDeps = {
  readonly drafts: DraftRepo
  readonly unitOfWork: UnitOfWork
  readonly idempotency: IdempotencyStore
}

export async function confirmDraftCommand(
  deps: ConfirmDraftDeps,
  command: ConfirmDraftCommand
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
          const confirmed = confirmDraft(draft)
          await deps.drafts.save(confirmed, { expectedRevision: command.expectedRevision })
          return { ok: true, value: { draft: confirmed } }
        } catch (error: unknown) {
          return mapThrownToResult(error)
        }
      },
      { type: 'draft.confirmed', aggregateId: command.draftId }
    )
  )
}
