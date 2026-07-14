import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveConversationMode } from '../../src/server/conversation/service.ts'
import { AppError } from '../../src/server/error.ts'
import { THREAD_KIND_CHAT, THREAD_KIND_CREATE_TASK } from '../../src/server/threads/types.ts'

test('chat thread + generateDraft=true is rejected with 409 conversation.mode_mismatch', () => {
  assert.throws(
    () => resolveConversationMode({ threadKind: THREAD_KIND_CHAT, requestedDraft: true }),
    (error: unknown) => {
      assert.ok(error instanceof AppError)
      assert.equal(error.httpStatus, 409)
      assert.equal(error.status, 40901)
      assert.equal(error.data.turnErrorCode, 'conversation.mode_mismatch')
      return true
    }
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
