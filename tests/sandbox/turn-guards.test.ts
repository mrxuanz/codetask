import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  isSandboxTurnCancelled,
  safePollSandboxExit,
  throwIfSandboxTurnAborted
} from '../../src/server/sandbox/turn-guards.ts'
import { SandboxError } from '../../src/server/sandbox/types.ts'

describe('turn-guards', () => {
  it('safePollSandboxExit treats closed handles as exited', () => {
    const handle = {
      pollExit: () => {
        throw new SandboxError('sandbox child closed', 'sandbox.child_closed')
      }
    }
    assert.equal(safePollSandboxExit(handle as never), -1)
  })

  it('throwIfSandboxTurnAborted throws sandbox.turn.cancelled', () => {
    const controller = new AbortController()
    controller.abort()
    assert.throws(
      () => throwIfSandboxTurnAborted(controller.signal),
      (error: unknown) => {
        assert.ok(error instanceof SandboxError)
        assert.equal((error as SandboxError).code, 'sandbox.turn.cancelled')
        return true
      }
    )
  })

  it('does not treat ACP tool Aborted as user cancellation', () => {
    assert.equal(isSandboxTurnCancelled(new Error('Read on foo.ts → Error: Aborted')), false)
  })
})
