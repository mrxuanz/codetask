import assert from 'node:assert/strict'
import test from 'node:test'
import { advanceTextSnapshot, appendTextPiece } from '../../src/server/agent-runtime/delta-emit'

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
