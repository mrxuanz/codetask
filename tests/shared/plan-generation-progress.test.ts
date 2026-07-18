import assert from 'node:assert/strict'
import test from 'node:test'
import { resolvePlanningPercent } from '../../src/shared/plan-generation-progress'

test('plan generation progress reserves analysis and outline stages', () => {
  assert.equal(resolvePlanningPercent(0, 0), 10)
  assert.equal(resolvePlanningPercent(0, 5), 20)
})

test('task context progress uses the locked total instead of done + 1', () => {
  assert.equal(resolvePlanningPercent(1, 5), 34)
  assert.equal(resolvePlanningPercent(2, 5), 48)
  assert.equal(resolvePlanningPercent(4, 5), 76)
  assert.equal(resolvePlanningPercent(5, 5), 90)
})
