import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RequestError } from '@agentclientprotocol/sdk'
import { isUserTurnCancellation } from '../../src/server/agent-runtime/cancel-detection.ts'
import { SandboxError } from '../../src/server/sandbox/types.ts'

describe('isUserTurnCancellation', () => {
  it('does not guess user intent from AbortError names or message text', () => {
    const abortErr = new Error('x')
    abortErr.name = 'AbortError'
    assert.equal(isUserTurnCancellation(abortErr), false)
    assert.equal(isUserTurnCancellation(new Error('This operation was aborted')), false)
    assert.equal(isUserTurnCancellation(new Error('The operation was aborted.')), false)
  })

  it('detects sandbox and ACP protocol cancellation codes', () => {
    assert.equal(isUserTurnCancellation(new SandboxError('x', 'sandbox.turn.cancelled')), true)
    assert.equal(isUserTurnCancellation(new RequestError(-32800, 'Cancelled')), true)
  })

  it('does not treat ACP tool Aborted as user cancellation', () => {
    assert.equal(isUserTurnCancellation(new Error('Read on foo.ts → Error: Aborted')), false)
    assert.equal(
      isUserTurnCancellation(new Error('Cursor ACP authenticate 失败：Internal error')),
      false
    )
  })
})
