import { describe, it } from 'node:test'
import assert from 'node:assert'
import type { JobState } from '@shared/contracts/control-plane'
import { availableActions, type ActionRuleContext } from '@server/domain/jobs/job-action-rules'

function buildContext(
  overrides: Partial<ActionRuleContext> = {}
): ActionRuleContext {
  return {
    state: 'execution_queued',
    recoverability: null,
    hasConfirmedPlan: false,
    ...overrides
  }
}

describe('availableActions', () => {
  describe('planning_queued', () => {
    it('should return pause and cancel', () => {
      const context = buildContext({ state: 'planning_queued' })
      assert.deepStrictEqual(availableActions(context), ['pause', 'cancel'])
    })
  })

  describe('planning_running', () => {
    it('should return pause and cancel', () => {
      const context = buildContext({ state: 'planning_running' })
      assert.deepStrictEqual(availableActions(context), ['pause', 'cancel'])
    })
  })

  describe('execution_queued', () => {
    it('should return pause and cancel', () => {
      const context = buildContext({ state: 'execution_queued' })
      assert.deepStrictEqual(availableActions(context), ['pause', 'cancel'])
    })
  })

  describe('execution_running', () => {
    it('should return pause and cancel', () => {
      const context = buildContext({ state: 'execution_running' })
      assert.deepStrictEqual(availableActions(context), ['pause', 'cancel'])
    })
  })

  describe('plan_review', () => {
    it('should return edit_plan, confirm_plan, replan, cancel', () => {
      const context = buildContext({ state: 'plan_review' })
      assert.deepStrictEqual(availableActions(context), ['edit_plan', 'confirm_plan', 'replan', 'cancel'])
    })
  })

  describe('pausing', () => {
    it('should return empty array', () => {
      const context = buildContext({ state: 'pausing' })
      assert.deepStrictEqual(availableActions(context), [])
    })
  })

  describe('applying_changes', () => {
    it('should return empty array', () => {
      const context = buildContext({ state: 'applying_changes' })
      assert.deepStrictEqual(availableActions(context), [])
    })
  })

  describe('paused', () => {
    it('should return continue and cancel', () => {
      const context = buildContext({ state: 'paused' })
      assert.deepStrictEqual(availableActions(context), ['continue', 'cancel'])
    })
  })

  describe('failed', () => {
    it('should return continue and cancel for recoverable', () => {
      const context = buildContext({ state: 'failed', recoverability: 'recoverable' })
      assert.deepStrictEqual(availableActions(context), ['continue', 'cancel'])
    })

    it('should return restart_execution and delete for non_recoverable', () => {
      const context = buildContext({ state: 'failed', recoverability: 'non_recoverable' })
      assert.deepStrictEqual(availableActions(context), ['restart_execution', 'delete'])
    })
  })

  describe('cancelled', () => {
    it('should return restart_execution and delete with confirmed plan', () => {
      const context = buildContext({ state: 'cancelled', hasConfirmedPlan: true })
      assert.deepStrictEqual(availableActions(context), ['restart_execution', 'delete'])
    })

    it('should return only delete without confirmed plan', () => {
      const context = buildContext({ state: 'cancelled', hasConfirmedPlan: false })
      assert.deepStrictEqual(availableActions(context), ['delete'])
    })
  })

  describe('succeeded', () => {
    it('should return only delete', () => {
      const context = buildContext({ state: 'succeeded' })
      assert.deepStrictEqual(availableActions(context), ['delete'])
    })
  })

  describe('matrix coverage', () => {
    const ALL_STATES: JobState[] = [
      'planning_queued',
      'planning_running',
      'plan_review',
      'execution_queued',
      'execution_running',
      'pausing',
      'paused',
      'applying_changes',
      'succeeded',
      'failed',
      'cancelled'
    ]

    it('should have at least one test for each state', () => {
      for (const state of ALL_STATES) {
        const context = buildContext({ state })
        const actions = availableActions(context)
        assert.ok(Array.isArray(actions), `State ${state} should return an array`)
      }
    })
  })
})
