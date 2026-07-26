import { confirmDraftSection } from '../../domain/drafts/transitions'
import type { Draft } from '../../domain/drafts/types'
import type { DraftRepo } from '../ports/repositories'
import type { UnitOfWork } from '../ports/unit-of-work'
import type { IdempotencyStore } from '../idempotency'
import { fail, type CommandResult } from '../results'
import { mapThrownToResult, runInUow, withIdempotency, type CommandBase } from './helpers'

export type ConfirmDraftSectionCommand = CommandBase & {
  readonly draftId: string
  readonly expectedRevision: number
  readonly sectionKey: string
}

export type ConfirmDraftSectionDeps = {
  readonly drafts: DraftRepo
  readonly unitOfWork: UnitOfWork
  readonly idempotency: IdempotencyStore
}

export async function confirmDraftSectionCommand(
  deps: ConfirmDraftSectionDeps,
  command: ConfirmDraftSectionCommand
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
          const next = confirmDraftSection(draft, command.sectionKey)
          if (next !== draft) {
            await deps.drafts.save(next, { expectedRevision: command.expectedRevision })
          }
          return { ok: true, value: { draft: next } }
        } catch (error: unknown) {
          return mapThrownToResult(error)
        }
      },
      { type: 'draft.section_confirmed', aggregateId: command.draftId }
    )
  )
}
