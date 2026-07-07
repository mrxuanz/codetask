import assert from 'node:assert/strict'
import test from 'node:test'
import {
  advanceTextSnapshot,
  appendTextPiece,
  MAX_TURN_TEXT_CHARS
} from '../../src/server/agent-runtime/delta-emit'

test('appendTextPiece emits only new suffix', () => {
  assert.deepEqual(appendTextPiece('hello', ' world'), {
    text: 'hello world',
    delta: ' world'
  })
  assert.deepEqual(appendTextPiece('hello', ''), { text: 'hello', delta: null })
})

test('advanceTextSnapshot emits suffix for growing snapshots', () => {
  assert.deepEqual(advanceTextSnapshot('Review', 'Reviewing'), {
    text: 'Reviewing',
    delta: 'ing'
  })
  assert.deepEqual(advanceTextSnapshot('same', 'same'), { text: 'same', delta: null })
})

test('advanceTextSnapshot replaces non-prefix snapshots', () => {
  assert.deepEqual(advanceTextSnapshot('old', 'new'), {
    text: 'new',
    delta: 'new'
  })
})

test('appendTextPiece respects maxChars and stops emitting deltas at cap', () => {
  assert.deepEqual(appendTextPiece('abcd', 'efgh', { maxChars: 6 }), {
    text: 'abcdef',
    delta: 'ef'
  })
  assert.deepEqual(appendTextPiece('abcdef', 'ghij', { maxChars: 6 }), {
    text: 'abcdef',
    delta: null
  })
})

test('MAX_TURN_TEXT_CHARS is a generous per-turn ceiling', () => {
  assert.ok(MAX_TURN_TEXT_CHARS >= 1_000_000)
})
