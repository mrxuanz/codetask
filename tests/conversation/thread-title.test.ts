import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildThreadTitleSeed,
  canReplaceThreadTitle,
  canSeedThreadTitle,
  isFirstUserMessage,
  sanitizeThreadTitle
} from '../../src/server/conversation/thread-title-logic.ts'
import {
  DEFAULT_THREAD_TITLE,
  THREAD_KIND_CHAT,
  TITLE_SOURCE_MANUAL
} from '../../src/server/threads/types.ts'

test('isFirstUserMessage requires exactly one user text message', () => {
  assert.equal(
    isFirstUserMessage([
      {
        id: '1',
        role: 'user',
        kind: 'text',
        content: 'hi',
        attachments: [],
        coreCode: 'codex',
        createdAt: ''
      }
    ]),
    true
  )
  assert.equal(
    isFirstUserMessage([
      {
        id: '1',
        role: 'user',
        kind: 'text',
        content: 'hi',
        attachments: [],
        coreCode: 'codex',
        createdAt: ''
      },
      {
        id: '2',
        role: 'assistant',
        kind: 'text',
        content: 'hello',
        attachments: [],
        coreCode: 'codex',
        createdAt: ''
      }
    ]),
    true
  )
  assert.equal(
    isFirstUserMessage([
      {
        id: '1',
        role: 'user',
        kind: 'text',
        content: 'hi',
        attachments: [],
        coreCode: 'codex',
        createdAt: ''
      },
      {
        id: '2',
        role: 'user',
        kind: 'text',
        content: 'again',
        attachments: [],
        coreCode: 'codex',
        createdAt: ''
      }
    ]),
    false
  )
})

test('canSeedThreadTitle skips manual rename', () => {
  assert.equal(
    canSeedThreadTitle({
      title: DEFAULT_THREAD_TITLE,
      titleSource: 'auto',
      threadKind: THREAD_KIND_CHAT
    }),
    true
  )
  assert.equal(
    canSeedThreadTitle({
      title: DEFAULT_THREAD_TITLE,
      titleSource: TITLE_SOURCE_MANUAL,
      threadKind: THREAD_KIND_CHAT
    }),
    false
  )
})

test('canReplaceThreadTitle allows default title or matching seed', () => {
  assert.equal(canReplaceThreadTitle(DEFAULT_THREAD_TITLE, '静态博客首页'), true)
  assert.equal(canReplaceThreadTitle('静态博客首页', '静态博客首页'), true)
  assert.equal(canReplaceThreadTitle('Custom title', '静态博客首页'), false)
})

test('sanitizeThreadTitle trims quotes and length', () => {
  assert.equal(sanitizeThreadTitle('"静态博客首页"'), '静态博客首页')
  assert.equal(sanitizeThreadTitle('New thread'), null)
  assert.equal(sanitizeThreadTitle('   '), null)
})

test('buildThreadTitleSeed truncates first line and supports image-only turns', () => {
  assert.equal(buildThreadTitleSeed({ userMessage: '静态博客首页\n第二行' }), '静态博客首页')
  assert.equal(
    buildThreadTitleSeed({ userMessage: '   ', imageAttachmentName: 'screenshot.png' }),
    'Image: screenshot.png'
  )
  assert.equal(buildThreadTitleSeed({ userMessage: 'New thread' }), null)
})
