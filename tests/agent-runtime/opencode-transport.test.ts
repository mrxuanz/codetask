import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createOpencodeLongTurnFetch,
  isTransientOpencodeTransportDetail
} from '../../src/server/agent-runtime/providers/opencode-transport.ts'
import { createTurnError } from '../../src/shared/turn-errors/turn-error.ts'
import { isRetryableTurnError } from '../../src/shared/turn-errors.ts'

describe('OpenCode transport classification', () => {
  it('treats undici fetch failed / socket errors as transient', () => {
    assert.equal(isTransientOpencodeTransportDetail('fetch failed'), true)
    assert.equal(isTransientOpencodeTransportDetail('fetch failed: Headers Timeout Error'), true)
    assert.equal(isTransientOpencodeTransportDetail('read ECONNRESET'), true)
    assert.equal(isTransientOpencodeTransportDetail('UND_ERR_BODY_TIMEOUT'), true)
    assert.equal(isTransientOpencodeTransportDetail('other side closed'), true)
    assert.equal(
      isTransientOpencodeTransportDetail('Failed to parse URL from [object Request]: Invalid URL'),
      true
    )
  })

  it('does not treat logical session failures as transient', () => {
    assert.equal(isTransientOpencodeTransportDetail('OpenCode session error'), false)
    assert.equal(isTransientOpencodeTransportDetail('model refused the request'), false)
    assert.equal(isTransientOpencodeTransportDetail('invalid tool arguments'), false)
  })

  it('maps stream_disconnected to retryable infra', () => {
    const err = createTurnError('provider.opencode.stream_disconnected', {
      detail: 'fetch failed'
    })
    assert.equal(isRetryableTurnError(err), true)
  })

  it('long-turn fetch accepts global Request objects (OpenCode SDK shape)', async () => {
    const longTurn = createOpencodeLongTurnFetch()
    try {
      const req = new Request('http://127.0.0.1:9/opencode-probe', { method: 'GET' })
      await longTurn.fetch(req)
      assert.fail('expected connection failure')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      assert.equal(message.includes('parse URL'), false, message)
      assert.ok(
        message.toLowerCase().includes('fetch failed') || /econn/i.test(message),
        message
      )
    } finally {
      longTurn.close()
    }
  })
})
