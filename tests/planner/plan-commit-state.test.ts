import assert from 'node:assert/strict'
import test from 'node:test'
import { isPlannerPlanCommitted } from '../../src/server/planner/mcp/session.ts'

test('isPlannerPlanCommitted is true when session committed after abortTurn', () => {
  assert.equal(isPlannerPlanCommitted(false, { planCommitted: true }), true)
})

test('isPlannerPlanCommitted is false when turn cancelled without commit', () => {
  assert.equal(isPlannerPlanCommitted(false, { planCommitted: false }), false)
  assert.equal(isPlannerPlanCommitted(false, null), false)
})

test('isPlannerPlanCommitted respects local flag', () => {
  assert.equal(isPlannerPlanCommitted(true, { planCommitted: false }), true)
})
