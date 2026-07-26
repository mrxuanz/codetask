import { confirmPlan } from '../../domain/plans/transitions'
import type { Plan } from '../../domain/plans/types'
import type { PlanRepo } from '../ports/repositories'
import type { UnitOfWork } from '../ports/unit-of-work'
import type { IdempotencyStore } from '../idempotency'
import { fail, type CommandResult } from '../results'
import { mapThrownToResult, withIdempotency, type CommandBase } from './helpers'

export type ConfirmPlanCommand = CommandBase & {
  readonly planId: string
  readonly expectedRevision: number
}

export type ConfirmPlanDeps = {
  readonly plans: PlanRepo
  readonly unitOfWork: UnitOfWork
  readonly idempotency: IdempotencyStore
}

export async function confirmPlanCommand(
  deps: ConfirmPlanDeps,
  command: ConfirmPlanCommand
): Promise<CommandResult<{ plan: Plan }>> {
  return withIdempotency(deps.idempotency, command, async () => {
    try {
      return await deps.unitOfWork.run(async (tx) => {
        const plan = await deps.plans.get(command.planId)
        if (!plan) {
          return fail('plan.not_found', `Plan not found: ${command.planId}`)
        }
        const confirmed = confirmPlan(plan)
        await deps.plans.save(confirmed, { expectedRevision: command.expectedRevision })
        tx.enqueueEvent({ type: 'plan.confirmed', aggregateId: confirmed.id })
        return { ok: true as const, value: { plan: confirmed } }
      })
    } catch (error: unknown) {
      return mapThrownToResult(error)
    }
  })
}
