import { confirmDraft } from '../../domain/drafts/transitions'
import { createJob, type Job } from '../../domain/jobs/types'
import type { Draft } from '../../domain/drafts/types'
import type { DraftRepo, JobRepo, PlanRepo } from '../ports/repositories'
import type { IdGenerator } from '../ports/id-generator'
import type { UnitOfWork } from '../ports/unit-of-work'
import type { IdempotencyStore } from '../idempotency'
import { fail, type CommandResult } from '../results'
import { mapThrownToResult, withIdempotency, type CommandBase } from './helpers'

export type ConfirmDraftFinalCommand = CommandBase & {
  readonly draftId: string
  readonly expectedRevision: number
  readonly jobId?: string
}

export type ConfirmDraftFinalDeps = {
  readonly drafts: DraftRepo
  readonly plans: PlanRepo
  readonly jobs: JobRepo
  readonly ids: IdGenerator
  readonly unitOfWork: UnitOfWork
  readonly idempotency: IdempotencyStore
}

/**
 * Confirm a collecting draft and enqueue / create a queued job when thread+project
 * are resolvable on the draft. Prefer creating from a confirmed plan when
 * `payload.planId` is set; otherwise create a queued job directly.
 */
export async function confirmDraftFinalCommand(
  deps: ConfirmDraftFinalDeps,
  command: ConfirmDraftFinalCommand
): Promise<CommandResult<{ draft: Draft; job: Job }>> {
  return withIdempotency(deps.idempotency, command, async () => {
    try {
      return await deps.unitOfWork.run(async (tx) => {
        const draft = await deps.drafts.get(command.draftId)
        if (!draft) {
          return fail('draft.not_found', `Draft not found: ${command.draftId}`)
        }
        if (!draft.threadId.trim() || !draft.projectId.trim()) {
          return fail(
            'draft.unresolvable',
            'Draft threadId/projectId required for confirm-final'
          )
        }

        let confirmed = draft
        if (draft.status === 'collecting') {
          confirmed = confirmDraft(draft)
          await deps.drafts.save(confirmed, {
            expectedRevision: command.expectedRevision
          })
          tx.enqueueEvent({ type: 'draft.confirmed', aggregateId: confirmed.id })
        } else if (draft.status !== 'confirmed') {
          return fail(
            'draft.not_collecting',
            `Cannot confirm-final draft in status ${draft.status}`
          )
        }

        const planId = confirmed.payload?.planId?.trim() || ''
        let job: Job
        if (planId) {
          const plan = await deps.plans.get(planId)
          if (plan?.status === 'confirmed') {
            job = createJob({
              id: command.jobId ?? deps.ids.next(),
              status: 'queued',
              planRevision: Number(plan.revision),
              executionGeneration: plan.executionGeneration,
              stateRevision: 0
            })
          } else {
            job = createJob({
              id: command.jobId ?? deps.ids.next(),
              status: 'queued',
              planRevision: 0,
              executionGeneration: 1,
              stateRevision: 0
            })
          }
        } else {
          job = createJob({
            id: command.jobId ?? deps.ids.next(),
            status: 'queued',
            planRevision: 0,
            executionGeneration: 1,
            stateRevision: 0
          })
        }

        await deps.jobs.save(job)
        tx.enqueueEvent({ type: 'job.enqueued', aggregateId: job.id })

        const withLink: Draft = {
          ...confirmed,
          payload: {
            ...confirmed.payload,
            ...(planId ? { planId } : {}),
            jobId: job.id
          }
        }
        await deps.drafts.save(withLink)
        return { ok: true as const, value: { draft: withLink, job } }
      })
    } catch (error: unknown) {
      return mapThrownToResult(error)
    }
  })
}
