import { planError } from './errors'
import type { Plan } from './types'
import { asPlanRevision } from './types'
import { validatePlan } from './validate'

/** Move plan into review. Allowed from editing (and idempotent when already in_review). */
export function markInReview(plan: Plan): Plan {
  if (plan.status === 'confirmed') {
    throw planError('plan.already_confirmed', 'Confirmed plan cannot enter review', {
      planId: plan.id
    })
  }
  if (plan.status === 'in_review') {
    return plan
  }
  return {
    ...plan,
    status: 'in_review',
    revision: asPlanRevision(Number(plan.revision) + 1)
  }
}

/**
 * Confirm plan for execution. Requires in_review, validates structure,
 * and bumps immutable executionGeneration.
 */
export function confirmPlan(plan: Plan): Plan {
  if (plan.status === 'confirmed') {
    throw planError('plan.already_confirmed', 'Plan is already confirmed', {
      planId: plan.id,
      executionGeneration: plan.executionGeneration
    })
  }
  if (plan.status !== 'in_review') {
    throw planError(
      'plan.not_in_review',
      'Plan must be in_review before confirm',
      { planId: plan.id, status: plan.status }
    )
  }
  validatePlan(plan)
  return {
    ...plan,
    status: 'confirmed',
    revision: asPlanRevision(Number(plan.revision) + 1),
    executionGeneration: plan.executionGeneration + 1
  }
}
