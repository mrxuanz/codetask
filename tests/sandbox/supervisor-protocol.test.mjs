import test from 'node:test'
import assert from 'node:assert/strict'

function isSupervisorEvent(value) {
  return (
    typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'
  )
}

test('supervisor ready event shape', () => {
  const event = { type: 'ready' }
  assert.equal(isSupervisorEvent(event), true)
})

test('supervisor chunk event carries sessionId', () => {
  const event = {
    type: 'chunk',
    sessionId: 'sess-1',
    chunk: { type: 'delta', content: 'hi' }
  }
  assert.equal(isSupervisorEvent(event), true)
  assert.equal(event.sessionId, 'sess-1')
})

test('supervisor exit event status values', () => {
  for (const status of ['exited', 'cancelled', 'timed_out', 'failed']) {
    const event = { type: 'exit', sessionId: 's', code: -1, status }
    assert.equal(isSupervisorEvent(event), true)
  }
})
