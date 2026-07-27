import assert from 'node:assert/strict'
import test from 'node:test'
import { formatOpencodeProviderError } from '../../src/server/agent-runtime/providers/opencode-sdk'

test('formatOpencodeProviderError preserves typed provider error details', () => {
  assert.equal(
    formatOpencodeProviderError({
      name: 'UnknownError',
      data: { message: 'unknown certificate verification error' }
    }),
    'UnknownError: unknown certificate verification error'
  )
})

test('formatOpencodeProviderError supports ordinary Error-like objects', () => {
  assert.equal(
    formatOpencodeProviderError({ message: 'connection closed' }),
    'connection closed'
  )
})
