import {
  applyOperation,
  markInReview,
  validatePlan,
  type Plan,
  type PlanOperation
} from '../../domain/plans/index'
import type { PlanRepo } from '../ports/repositories'
import type { UnitOfWork } from '../ports/unit-of-work'
import { fail, type CommandResult } from '../results'
import { mapThrownToResult } from '../commands/helpers'
import {
  assertNotAborted,
  resolveWorkSignal,
  type WorkContext
} from './work-context'

export type PlanValidateWorkInput = {
  readonly planId: string
  /** When set, apply operations before validate (illegal ops rejected). */
  readonly operations?: readonly PlanOperation[]
  /** When true, move editing → in_review after successful validate. */
  readonly markInReview?: boolean
  readonly expectedRevision?: number
  readonly signal?: AbortSignal
}

export type PlanValidateWorkDeps = {
  readonly plans: PlanRepo
  readonly unitOfWork: UnitOfWork
}

/**
 * Work-layer wrapper around domain plan validate (+ optional ops).
 * Skills never write; this work commits after validation.
 */
export async function planValidateWork(
  deps: PlanValidateWorkDeps,
  input: PlanValidateWorkInput,
  context?: WorkContext
): Promise<CommandResult<{ plan: Plan }>> {
  const signal = resolveWorkSignal(context, input.signal)
  try {
    assertNotAborted(signal)
    return await deps.unitOfWork.run(async (tx) => {
      assertNotAborted(signal)
      const existing = await deps.plans.get(input.planId)
      if (!existing) {
        return fail('plan.not_found', `Plan not found: ${input.planId}`)
      }

      let plan: Plan = existing
      if (input.operations?.length) {
        for (const op of input.operations) {
          plan = applyOperation(plan, op)
        }
      }

      validatePlan(plan)

      if (input.markInReview) {
        plan = markInReview(plan)
      }

      await deps.plans.save(plan, {
        expectedRevision: input.expectedRevision ?? Number(existing.revision)
      })
      tx.enqueueEvent({ type: 'plan.validated', aggregateId: plan.id })
      return { ok: true as const, value: { plan } }
    })
  } catch (error: unknown) {
    if (error instanceof Error && (error.name === 'AbortError' || (error as { code?: string }).code === 'work.aborted')) {
      return fail('work.aborted', error.message)
    }
    return mapThrownToResult(error)
  }
}
