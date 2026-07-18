import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  TASK_EVIDENCE_GRACE_MS,
  TASK_EVIDENCE_WAIT_FULL_MS,
  VERIFIER_VERDICT_GRACE_MS
} from '../../src/server/legacy-control-plane/recovery-limits.ts'
import { TASK_TURN_STALLED_MS } from '../../src/server/agent-runtime/turn-timeouts.ts'

describe('evidence wait vs stall policy', () => {
  it('no longer uses a mid-turn 45min evidence wall clock', () => {
    // Former TASK_EVIDENCE_WAIT_FULL_MS (45min) killed active agents that had not
    // yet called report_task_result. Mid-turn stall is ProgressGuard only.
    assert.equal(TASK_EVIDENCE_WAIT_FULL_MS, TASK_EVIDENCE_GRACE_MS)
    assert.ok(TASK_TURN_STALLED_MS >= 60 * 60_000)
    assert.ok(TASK_EVIDENCE_GRACE_MS < TASK_TURN_STALLED_MS)
    assert.equal(VERIFIER_VERDICT_GRACE_MS, TASK_EVIDENCE_GRACE_MS)
  })
})
