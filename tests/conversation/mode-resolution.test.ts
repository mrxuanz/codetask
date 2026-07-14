import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertConversationMode,
  resolveConversationMode
} from '../../src/server/conversation/service.ts'
import { AppError } from '../../src/server/error.ts'
import { THREAD_KIND_CHAT, THREAD_KIND_CREATE_TASK } from '../../src/server/threads/types.ts'

function expectModeMismatch(fn: () => void): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof AppError)
    assert.equal(error.httpStatus, 409)
    assert.equal(error.status, 40901)
    assert.equal(error.data.turnErrorCode, 'conversation.mode_mismatch')
    return true
  })
}

test('chat thread + generateDraft=true is rejected with 409 conversation.mode_mismatch', () => {
  expectModeMismatch(() =>
    resolveConversationMode({ threadKind: THREAD_KIND_CHAT, requestedDraft: true })
  )
})

test('chat thread + createTaskMode is rejected with 409 conversation.mode_mismatch', () => {
  expectModeMismatch(() =>
    assertConversationMode({
      threadKind: THREAD_KIND_CHAT,
      requestedCreateTaskMode: true,
      requestedDraft: false
    })
  )
})

test('create_task thread without create-task request is rejected with 409 conversation.mode_mismatch', () => {
  expectModeMismatch(() =>
    assertConversationMode({
      threadKind: THREAD_KIND_CREATE_TASK,
      requestedCreateTaskMode: false,
      requestedDraft: false
    })
  )
})

test('chat thread without generateDraft resolves to a non-draft chat mode', () => {
  const mode = resolveConversationMode({ threadKind: THREAD_KIND_CHAT, requestedDraft: false })
  assert.deepEqual(mode, { kind: THREAD_KIND_CHAT, generateDraft: false })
})

test('create_task thread honors the requested draft flag either way', () => {
  const draftMode = resolveConversationMode({
    threadKind: THREAD_KIND_CREATE_TASK,
    requestedDraft: true
  })
  assert.deepEqual(draftMode, { kind: THREAD_KIND_CREATE_TASK, generateDraft: true })

  const chatLikeMode = resolveConversationMode({
    threadKind: THREAD_KIND_CREATE_TASK,
    requestedDraft: false
  })
  assert.deepEqual(chatLikeMode, { kind: THREAD_KIND_CREATE_TASK, generateDraft: false })
})
