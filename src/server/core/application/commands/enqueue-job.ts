import { createJob, type Job } from '../../domain/jobs/types'
import type { JobRepo, PlanRepo } from '../ports/repositories'
import type { IdGenerator } from '../ports/id-generator'
import type { UnitOfWork } from '../ports/unit-of-work'
import type { IdempotencyStore } from '../idempotency'
import { fail, type CommandResult } from '../results'
import { mapThrownToResult, withIdempotency, type CommandBase } from './helpers'

export type EnqueueJobCommand = CommandBase & {
  readonly planId: string
  readonly jobId?: string
  readonly expectedPlanRevision?: number
}

export type EnqueueJobDeps = {
  readonly plans: PlanRepo
  readonly jobs: JobRepo
  readonly ids: IdGenerator
  readonly unitOfWork: UnitOfWork
  readonly idempotency: IdempotencyStore
}

export async function enqueueJobCommand(
  deps: EnqueueJobDeps,
  command: EnqueueJobCommand
): Promise<CommandResult<{ job: Job }>> {
  return withIdempotency(deps.idempotency, command, async () => {
    try {
      return await deps.unitOfWork.run(async (tx) => {
        const plan = await deps.plans.get(command.planId)
        if (!plan) {
          return fail('plan.not_found', `Plan not found: ${command.planId}`)
        }
        if (plan.status !== 'confirmed') {
          return fail('plan.not_confirmed', `Plan must be confirmed before enqueue`)
        }
        if (
          command.expectedPlanRevision !== undefined &&
          Number(plan.revision) !== command.expectedPlanRevision
        ) {
          return fail('revision.conflict', 'Stale plan revision on enqueue')
        }

        const job = createJob({
          id: command.jobId ?? deps.ids.next(),
          status: 'queued',
          planRevision: Number(plan.revision),
          executionGeneration: plan.executionGeneration,
          stateRevision: 0
        })
        await deps.jobs.save(job)
        tx.enqueueEvent({ type: 'job.enqueued', aggregateId: job.id })
        return { ok: true as const, value: { job } }
      })
    } catch (error: unknown) {
      return mapThrownToResult(error)
    }
  })
}
