import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isPlannerSilentEmptyTurnError,
  plannerSessionTouchedStructuredPlan,
  resolvePlannerMissingFinalizeError
} from '../../src/server/design-session/planner-finalize'
import { createTurnError, isRetryableTurnError } from '../../src/shared/turn-errors'
import { planFailureFromSandboxError } from '../../src/server/sandbox/sandbox-failure'

test('plannerSessionTouchedStructuredPlan detects outline or contexts', () => {
  assert.equal(
    plannerSessionTouchedStructuredPlan({ planOutline: null, taskContexts: new Map() }),
    false
  )
  assert.equal(
    plannerSessionTouchedStructuredPlan({
      planOutline: { milestones: [] } as never,
      taskContexts: new Map()
    }),
    true
  )
  const contexts = new Map([['m1-s1-t1', { content: 'x' } as never]])
  assert.equal(
    plannerSessionTouchedStructuredPlan({ planOutline: null, taskContexts: contexts }),
    true
  )
})

test('resolvePlannerMissingFinalizeError treats empty MCP as turn.incomplete', () => {
  const error = resolvePlannerMissingFinalizeError({
    planOutline: null,
    taskContexts: new Map(),
    finalizerError: undefined
  })
  assert.equal((error as { code?: string }).code, 'turn.incomplete')
  assert.equal(isPlannerSilentEmptyTurnError(error), true)
  assert.equal(isRetryableTurnError(error), true)
})

test('resolvePlannerMissingFinalizeError treats partial MCP without finalize as plan_not_ready', () => {
  const error = resolvePlannerMissingFinalizeError({
    planOutline: { milestones: [] } as never,
    taskContexts: new Map(),
    finalizerError: undefined
  })
  assert.equal((error as { code?: string }).code, 'draft.plan_not_ready')
  assert.equal(isPlannerSilentEmptyTurnError(error), false)
  assert.equal(isRetryableTurnError(error), false)
})

test('resolvePlannerMissingFinalizeError prefers finalizerError', () => {
  const finalizerError = createTurnError('turn.unknown', { detail: 'closed' })
  const error = resolvePlannerMissingFinalizeError({
    planOutline: null,
    taskContexts: new Map(),
    finalizerError
  })
  assert.equal(error, finalizerError)
})

test('planFailureFromSandboxError preserves capacity_limited on lastError', () => {
  const failure = planFailureFromSandboxError(createTurnError('turn.capacity_limited'))
  assert.equal(failure.lastError.code, 'turn.capacity_limited')
  assert.equal(failure.planProgress.progressCode, 'plan.planning_failed')
  assert.equal(failure.planProgress.progressParams?.providerCode, 'turn.capacity_limited')
})

test('planFailureFromSandboxError preserves silent empty incomplete code', () => {
  const failure = planFailureFromSandboxError(
    createTurnError('turn.incomplete', {
      detail:
        'Planner turn ended without calling any plan MCP tools (provider may have disconnected before structured planning began)'
    })
  )
  assert.equal(failure.lastError.code, 'turn.incomplete')
  assert.notEqual(failure.lastError.code, 'draft.plan_not_ready')
})
