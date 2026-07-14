import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertFrozenAttachmentId,
  assertFrozenThreadId,
  FrozenIdError
} from '../../src/shared/frozen-ids'

const THREAD_ID = '11111111-1111-4111-8111-111111111111'
const ATTACHMENT_ID = 'att-22222222-2222-4222-8222-222222222222'

test('assertFrozenThreadId accepts uuid', () => {
  assert.equal(assertFrozenThreadId(THREAD_ID), THREAD_ID)
})

test('assertFrozenAttachmentId accepts att-prefixed uuid', () => {
  assert.equal(assertFrozenAttachmentId(ATTACHMENT_ID), ATTACHMENT_ID)
})

test('assertFrozenThreadId rejects traversal', () => {
  assert.throws(
    () => assertFrozenThreadId('../' + THREAD_ID),
    (error: unknown) => error instanceof FrozenIdError
  )
})

test('assertFrozenAttachmentId rejects encoded traversal', () => {
  assert.throws(
    () => assertFrozenAttachmentId('att-%2e%2e%2fsecret'),
    (error: unknown) => error instanceof FrozenIdError
  )
})
