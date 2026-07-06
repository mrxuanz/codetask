import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConversationMessageDto } from '../../src/server/conversation/types'
import {
  buildConversationHistoryBlock,
  shouldSeedConversationHistory
} from '../../src/server/conversation/history'
import {
  buildMessageThinkingPayload,
  extractMessageThinking,
  thinkingDurationSeconds
} from '../../src/shared/message-thinking'

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

test('buildConversationHistoryBlock excludes thinking from prior turns', () => {
  const messages: ConversationMessageDto[] = [
    {
      id: 'u1',
      role: 'user',
      kind: 'text',
      content: 'Hello',
      attachments: [],
      coreCode: 'codex',
      createdAt: '2026-07-01T00:00:00.000Z'
    },
    {
      id: 'a1',
      role: 'assistant',
      kind: 'text',
      content: 'Hi there',
      thinking: 'internal chain of thought',
      thinkingDurationMs: 3200,
      attachments: [],
      coreCode: 'codex',
      payload: buildMessageThinkingPayload('internal chain of thought', 3200),
      createdAt: '2026-07-01T00:00:01.000Z'
    }
  ]

  const block = buildConversationHistoryBlock(messages)
  assert.match(block ?? '', /\*\*Assistant \(Codex\):\*\* Hi there/)
  assert.doesNotMatch(block ?? '', /internal chain of thought/)
})

test('shouldSeedConversationHistory always seeds fragile CLI adapters', () => {
  const userMessage: ConversationMessageDto = {
    id: 'u1',
    role: 'user',
    kind: 'text',
    content: 'Remember this',
    attachments: [],
    coreCode: 'cursorcli',
    createdAt: '2026-07-01T00:00:00.000Z'
  }
  const assistantMessage: ConversationMessageDto = {
    id: 'a1',
    role: 'assistant',
    kind: 'text',
    content: 'I will remember it',
    attachments: [],
    coreCode: 'cursorcli',
    runtimeSessionId: 'cursor-session-1',
    createdAt: '2026-07-01T00:00:01.000Z'
  }
  const prior = [userMessage, assistantMessage]

  assert.equal(shouldSeedConversationHistory('cursor-session-1', 'cursorcli', prior), true)
  assert.equal(
    shouldSeedConversationHistory('opencode-session-1', 'opencode', [
      { ...userMessage, coreCode: 'opencode' },
      { ...assistantMessage, coreCode: 'opencode', runtimeSessionId: 'opencode-session-1' }
    ]),
    true
  )
  assert.equal(
    shouldSeedConversationHistory('codex-session-1', 'codex', [
      { ...userMessage, coreCode: 'codex' },
      { ...assistantMessage, coreCode: 'codex', runtimeSessionId: 'codex-session-1' }
    ]),
    false
  )
})
