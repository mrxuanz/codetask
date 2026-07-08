import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  noFirstSignalMsForRole,
  stalledAfterMsForRole,
  TASK_TURN_STALLED_MS,
  usesTaskTurnTimeoutPolicy
} from '../../src/server/agent-runtime/turn-timeouts'

describe('turn-timeouts', () => {
  it('treats conversation like task-worker for timeout policy', () => {
    assert.equal(usesTaskTurnTimeoutPolicy('conversation'), true)
    assert.equal(usesTaskTurnTimeoutPolicy('task-worker'), true)
    assert.equal(usesTaskTurnTimeoutPolicy('planner'), false)
  })

  it('uses 60 minute stalled threshold for conversation and task-worker', () => {
    assert.equal(stalledAfterMsForRole('conversation'), TASK_TURN_STALLED_MS)
    assert.equal(stalledAfterMsForRole('task-worker'), TASK_TURN_STALLED_MS)
    assert.equal(stalledAfterMsForRole('planner'), 20 * 60_000)
  })

  it('skips short no-first-signal watchdog for conversation and task-worker', () => {
    assert.equal(noFirstSignalMsForRole('conversation'), null)
    assert.equal(noFirstSignalMsForRole('task-worker'), null)
    assert.equal(noFirstSignalMsForRole('planner'), 120_000)
  })
})
