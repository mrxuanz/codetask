import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compactTurnChunkForIpc,
  roleNeedsStreamingChunks
} from '../../src/server/agent-runtime/chunk-ipc'

test('roleNeedsStreamingChunks is true only for conversation', () => {
  assert.equal(roleNeedsStreamingChunks('conversation'), true)
  assert.equal(roleNeedsStreamingChunks('task-worker'), false)
  assert.equal(roleNeedsStreamingChunks('slice-verifier'), false)
})

test('compactTurnChunkForIpc drops deltas for task-worker', () => {
  assert.equal(compactTurnChunkForIpc('task-worker', { type: 'delta', content: 'hello' }), null)
  assert.equal(
    compactTurnChunkForIpc('task-worker', { type: 'thinking_delta', content: 'hmm' }),
    null
  )
})

test('compactTurnChunkForIpc strips reply on completed for non-streaming roles', () => {
  for (const role of ['task-worker', 'slice-verifier', 'milestone-verifier', 'planner'] as const) {
    assert.deepEqual(
      compactTurnChunkForIpc(role, {
        type: 'completed',
        reply: 'x'.repeat(10_000),
        runtimeSessionId: 'sess-1'
      }),
      { type: 'completed', reply: '', runtimeSessionId: 'sess-1' }
    )
  }
})

test('compactTurnChunkForIpc preserves conversation chunks', () => {
  const delta = { type: 'delta' as const, content: 'hi' }
  assert.equal(compactTurnChunkForIpc('conversation', delta), delta)
})
