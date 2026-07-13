import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type {
  JobState,
  JobAction,
  Recoverability
} from '../../../src/shared/contracts/control-plane/primitives'
import {
  availableActions,
  isTerminal,
  isActive
} from '../../../src/server/domain/jobs/job-action-rules'
import type { ActionRuleContext } from '../../../src/server/domain/jobs/job-action-rules'

const ALL_STATES: readonly JobState[] = [
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

function hasNoDuplicates(actions: readonly JobAction[]): boolean {
  return new Set(actions).size === actions.length
}

function buildContext(
  state: JobState,
  overrides?: { recoverability?: Recoverability | null; hasConfirmedPlan?: boolean }
): ActionRuleContext {
  return {
    state,
    recoverability: overrides?.recoverability ?? null,
    hasConfirmedPlan: overrides?.hasConfirmedPlan ?? false
  }
}

describe('job-action-rules', () => {
  describe('availableActions - table-driven', () => {
    const expectedActionsByState: ReadonlyMap<JobState, readonly JobAction[]> = new Map<JobState, readonly JobAction[]>([
      ['planning_queued', ['pause', 'cancel']],
      ['planning_running', ['pause', 'cancel']],
      ['plan_review', ['edit_plan', 'confirm_plan', 'replan', 'cancel']],
      ['execution_queued', ['pause', 'cancel']],
      ['execution_running', ['pause', 'cancel']],
      ['pausing', []],
      ['paused', ['continue', 'cancel']],
      ['applying_changes', []],
      ['succeeded', ['delete']],
      ['failed', ['restart_execution', 'delete']],
      ['cancelled', ['delete']]
    ])

    for (const [state, expected] of expectedActionsByState) {
      it(`returns ${JSON.stringify(expected)} for state=${state}`, () => {
        const ctx = buildContext(state)
        const actions = availableActions(ctx)
        assert.deepEqual(actions, expected)
        assert.ok(hasNoDuplicates(actions), `actions for ${state} must not contain duplicates`)
      })
    }
  })

  describe('recoverability affects failed state', () => {
    it('failed + recoverable → [continue, cancel]', () => {
      const ctx = buildContext('failed', { recoverability: 'recoverable' })
      const actions = availableActions(ctx)
      assert.deepEqual(actions, ['continue', 'cancel'])
      assert.ok(hasNoDuplicates(actions))
    })

    it('failed + non_recoverable → [restart_execution, delete]', () => {
      const ctx = buildContext('failed', { recoverability: 'non_recoverable' })
      const actions = availableActions(ctx)
      assert.deepEqual(actions, ['restart_execution', 'delete'])
      assert.ok(hasNoDuplicates(actions))
    })

    it('failed + null recoverability → [restart_execution, delete]', () => {
      const ctx = buildContext('failed', { recoverability: null })
      const actions = availableActions(ctx)
      assert.deepEqual(actions, ['restart_execution', 'delete'])
      assert.ok(hasNoDuplicates(actions))
    })
  })

  describe('hasConfirmedPlan affects cancelled state', () => {
    it('cancelled + hasConfirmedPlan=true → [restart_execution, delete]', () => {
      const ctx = buildContext('cancelled', { hasConfirmedPlan: true })
      const actions = availableActions(ctx)
      assert.deepEqual(actions, ['restart_execution', 'delete'])
      assert.ok(hasNoDuplicates(actions))
    })

    it('cancelled + hasConfirmedPlan=false → [delete]', () => {
      const ctx = buildContext('cancelled', { hasConfirmedPlan: false })
      const actions = availableActions(ctx)
      assert.deepEqual(actions, ['delete'])
      assert.ok(hasNoDuplicates(actions))
    })
  })

  describe('no duplicate actions in any result', () => {
    for (const state of ALL_STATES) {
      for (const recoverability of [null, 'recoverable' as const, 'non_recoverable' as const]) {
        for (const hasConfirmedPlan of [false, true]) {
          it(`no duplicates: state=${state} recoverability=${recoverability} hasConfirmedPlan=${hasConfirmedPlan}`, () => {
            const ctx = buildContext(state, { recoverability, hasConfirmedPlan })
            const actions = availableActions(ctx)
            assert.ok(
              hasNoDuplicates(actions),
              `duplicate actions found for state=${state}: ${JSON.stringify(actions)}`
            )
          })
        }
      }
    }
  })

  describe('isTerminal', () => {
    const terminalStates: readonly JobState[] = ['succeeded', 'failed', 'cancelled']
    const nonTerminalStates = ALL_STATES.filter((s) => !terminalStates.includes(s))

    for (const state of terminalStates) {
      it(`${state} is terminal`, () => {
        assert.equal(isTerminal(state), true)
      })
    }

    for (const state of nonTerminalStates) {
      it(`${state} is not terminal`, () => {
        assert.equal(isTerminal(state), false)
      })
    }
  })

  describe('isActive', () => {
    const activeStates: readonly JobState[] = [
      'planning_queued',
      'planning_running',
      'plan_review',
      'execution_queued',
      'execution_running'
    ]
    const inactiveStates: readonly JobState[] = [
      'pausing',
      'paused',
      'applying_changes',
      'succeeded',
      'failed',
      'cancelled'
    ]

    for (const state of activeStates) {
      it(`${state} is active`, () => {
        assert.equal(isActive(state), true)
      })
    }

    for (const state of inactiveStates) {
      it(`${state} is not active`, () => {
        assert.equal(isActive(state), false)
      })
    }
  })
})
