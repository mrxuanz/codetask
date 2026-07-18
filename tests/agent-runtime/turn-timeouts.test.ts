import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  noFirstSignalMsForRole,
  stalledAfterMsForRole,
  TASK_TURN_STALLED_MS,
  turnWallTimeoutMsForRole,
  usesTaskTurnTimeoutPolicy
} from '../../src/server/agent-runtime/turn-timeouts'
import { DEFAULT_SANDBOX_TURN_TIMEOUT_MS } from '../../src/server/sandbox/session-state'
import type { ConversationRole } from '../../src/server/agent-runtime/roles'

const ALL_ROLES: ConversationRole[] = [
  'conversation',
  'planner',
  'task-worker',
  'milestone-verifier',
  'slice-verifier'
]

describe('turn-timeouts', () => {
  it('uses the shared task-worker policy for every role', () => {
    for (const role of ALL_ROLES) {
      assert.equal(usesTaskTurnTimeoutPolicy(role), true)
      assert.equal(stalledAfterMsForRole(role), TASK_TURN_STALLED_MS)
      assert.equal(noFirstSignalMsForRole(role), null)
      assert.equal(turnWallTimeoutMsForRole(role), DEFAULT_SANDBOX_TURN_TIMEOUT_MS)
    }
  })
})
