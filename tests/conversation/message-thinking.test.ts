import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildMessageThinkingPayload,
  extractMessageThinking,
  thinkingDurationSeconds
} from '@codetask/contracts/message-thinking'

test('buildMessageThinkingPayload omits empty thinking', () => {
  assert.equal(buildMessageThinkingPayload(''), undefined)
  assert.equal(buildMessageThinkingPayload('   '), undefined)
})

test('buildMessageThinkingPayload stores text and duration', () => {
  assert.deepEqual(buildMessageThinkingPayload('reasoning trace', 4200), {
    thinking: 'reasoning trace',
    durationMs: 4200
  })
})

test('extractMessageThinking reads payload fields', () => {
  assert.deepEqual(extractMessageThinking(null), { text: null, durationMs: null })
  assert.deepEqual(extractMessageThinking({ thinking: ' hmm ' }), {
    text: 'hmm',
    durationMs: null
  })
  assert.deepEqual(extractMessageThinking({ thinking: 'trace', durationMs: 1500 }), {
    text: 'trace',
    durationMs: 1500
  })
})

test('thinkingDurationSeconds rounds to at least one second', () => {
  assert.equal(thinkingDurationSeconds(null), null)
  assert.equal(thinkingDurationSeconds(400), 1)
  assert.equal(thinkingDurationSeconds(2600), 3)
})
