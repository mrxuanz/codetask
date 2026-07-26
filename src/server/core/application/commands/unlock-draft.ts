import { JobCommandService } from '../../domain/jobs/transitions'
import { unlockDraft } from '../../domain/drafts/transitions'
import type { Draft } from '../../domain/drafts/types'
import type { DraftRepo, JobRepo } from '../ports/repositories'
import type { UnitOfWork } from '../ports/unit-of-work'
import type { IdempotencyStore } from '../idempotency'
import { fail, type CommandResult } from '../results'
import { mapThrownToResult, runInUow, withIdempotency, type CommandBase } from './helpers'

const jobCommands = new JobCommandService()

export type UnlockDraftCommand = CommandBase & {
  readonly draftId: string
  readonly expectedRevision: number
}

export type UnlockDraftDeps = {
  readonly drafts: DraftRepo
  readonly unitOfWork: UnitOfWork
  readonly idempotency: IdempotencyStore
  /** When present, cancel linked plan/job from draft payload (best-effort). */
  readonly jobs?: JobRepo
}

export async function unlockDraftCommand(
  deps: UnlockDraftDeps,
  command: UnlockDraftCommand
): Promise<CommandResult<{ draft: Draft }>> {
  return withIdempotency(deps.idempotency, command, () =>
    runInUow(
      deps.unitOfWork,
      async (tx) => {
        const draft = await deps.drafts.get(command.draftId)
        if (!draft) {
          return fail('draft.not_found', `Draft not found: ${command.draftId}`)
        }
        try {
          const linkedId =
            draft.payload?.planId?.trim() || draft.payload?.jobId?.trim() || ''
          const next = unlockDraft(draft)
          if (next !== draft) {
            await deps.drafts.save(next, { expectedRevision: command.expectedRevision })
          }

          if (linkedId && deps.jobs) {
            const job = await deps.jobs.get(linkedId)
            if (job) {
              try {
                const cancelled = jobCommands.cancel(job)
                if (cancelled !== job) {
                  await deps.jobs.save(cancelled, {
                    expectedRevision: job.stateRevision
                  })
                  tx.enqueueEvent({ type: 'job.cancelled', aggregateId: cancelled.id })
                }
              } catch {
                /* best-effort cancel — domain unlock already applied */
              }
            }
          }

          return { ok: true, value: { draft: next } }
        } catch (error: unknown) {
          return mapThrownToResult(error)
        }
      },
      { type: 'draft.unlocked', aggregateId: command.draftId }
    )
  )
}
