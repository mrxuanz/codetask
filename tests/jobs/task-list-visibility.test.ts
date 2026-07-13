import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isTaskListVisibleJob } from '../../src/server/legacy-control-plane/constants.ts'

describe('task list visibility', () => {
  it('hides planning-phase jobs before planConfirmedAt', () => {
    assert.equal(isTaskListVisibleJob({ status: 'planning', planConfirmedAt: null }), false)
    assert.equal(isTaskListVisibleJob({ status: 'plan_editing', planConfirmedAt: null }), false)
    assert.equal(isTaskListVisibleJob({ status: 'failed', planConfirmedAt: null }), false)
    assert.equal(isTaskListVisibleJob({ status: 'cancelled', planConfirmedAt: null }), false)
  })

  it('shows launched jobs after planConfirmedAt', () => {
    assert.equal(isTaskListVisibleJob({ status: 'pending', planConfirmedAt: 1 }), true)
    assert.equal(isTaskListVisibleJob({ status: 'running', planConfirmedAt: 1 }), true)
    assert.equal(isTaskListVisibleJob({ status: 'failed', planConfirmedAt: 1 }), true)
    assert.equal(isTaskListVisibleJob({ status: 'completed', planConfirmedAt: 1 }), true)
  })
})
