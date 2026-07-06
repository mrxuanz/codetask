import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractCodexReasoningText,
  extractLooseReasoningText
} from '../../src/server/agent-runtime/reasoning-text.ts'

test('extractCodexReasoningText reads summary_text and raw_content', () => {
  assert.equal(
    extractCodexReasoningText({
      type: 'reasoning',
      summary_text: ['Step one', 'Step two']
    }),
    'Step one\nStep two'
  )
  assert.equal(
    extractCodexReasoningText({
      type: 'reasoning',
      raw_content: ['raw thought']
    }),
    'raw thought'
  )
  assert.equal(
    extractCodexReasoningText({
      type: 'reasoning',
      text: 'legacy text'
    }),
    'legacy text'
  )
  assert.equal(extractCodexReasoningText({ type: 'agent_message', text: 'nope' }), null)
})

test('extractLooseReasoningText accepts common provider part shapes', () => {
  assert.equal(extractLooseReasoningText({ type: 'reasoning', text: 'trace' }), 'trace')
  assert.equal(extractLooseReasoningText({ type: 'thinking', thinking: 'trace' }), 'trace')
  assert.equal(extractLooseReasoningText({ type: 'text', text: 'reply' }), null)
})
