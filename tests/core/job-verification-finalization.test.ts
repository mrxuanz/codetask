import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildVerificationFinalizationPrompt,
  needsVerificationFinalizationRetry
} from '../../src/server/composition/job/verification-finalization.ts'

test('only empty verification replies receive a bounded finalization retry', () => {
  assert.equal(needsVerificationFinalizationRetry('work', ''), false)
  assert.equal(needsVerificationFinalizationRetry('work_validation', ''), true)
  assert.equal(needsVerificationFinalizationRetry('slice_validation', ' \n '), true)
  assert.equal(needsVerificationFinalizationRetry('milestone_validation', '{"status":"passed"}'), false)
})

test('verification finalization retry preserves the server-bound prompt and remains read-only', () => {
  const prompt = buildVerificationFinalizationPrompt('<SERVER_BOUND_CONTEXT>{"id":"item-1"}</SERVER_BOUND_CONTEXT>')
  assert.match(prompt, /SERVER_BOUND_CONTEXT/)
  assert.match(prompt, /exactly one JSON object/)
  assert.match(prompt, /Do not omit the final response/)
  assert.match(prompt, /do not modify any workspace file/i)
})
