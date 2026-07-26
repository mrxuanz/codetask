import type { Plan, PlanEdge, PlanNode } from '../../domain/plans/types'
import { asPlanId, asPlanRevision } from '../../domain/plans/types'
import type { PlanRepo } from '../ports/repositories'
import type { IdGenerator } from '../ports/id-generator'
import type { UnitOfWork } from '../ports/unit-of-work'
import type { IdempotencyStore } from '../idempotency'
import type { CommandResult } from '../results'
import { mapThrownToResult, withIdempotency, type CommandBase } from './helpers'

export type CreatePlanCommand = CommandBase & {
  readonly threadId: string
  readonly draftId?: string
  readonly planId?: string
  readonly nodes?: readonly PlanNode[]
  readonly edges?: readonly PlanEdge[]
}

export type CreatePlanDeps = {
  readonly plans: PlanRepo
  readonly ids: IdGenerator
  readonly unitOfWork: UnitOfWork
  readonly idempotency: IdempotencyStore
}

export async function createPlanCommand(
  deps: CreatePlanDeps,
  command: CreatePlanCommand
): Promise<CommandResult<{ plan: Plan }>> {
  return withIdempotency(deps.idempotency, command, async () => {
    try {
      return await deps.unitOfWork.run(async (tx) => {
        const planId = command.planId ?? deps.ids.next()
        const plan: Plan = {
          id: asPlanId(planId),
          revision: asPlanRevision(1),
          status: 'editing',
          nodes: command.nodes ? [...command.nodes] : [],
          edges: command.edges ? [...command.edges] : [],
          executionGeneration: 0,
          threadId: command.threadId,
          draftId: command.draftId
        }
        await deps.plans.save(plan)
        tx.enqueueEvent({ type: 'plan.created', aggregateId: plan.id })
        return { ok: true as const, value: { plan } }
      })
    } catch (error: unknown) {
      return mapThrownToResult(error)
    }
  })
}
