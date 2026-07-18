import assert from 'node:assert/strict'
import test from 'node:test'
import { generateAssetToken, validateAssetToken } from '../../src/server/auth/asset-token'

test('asset token is owner-scoped and expires', () => {
  const token = generateAssetToken('secret', 'alice', 'thread-1', 'att-1')
  assert.equal(validateAssetToken('secret', token, 'alice', 'thread-1', 'att-1'), true)
  assert.equal(validateAssetToken('secret', token, 'bob', 'thread-1', 'att-1'), false)
  assert.equal(validateAssetToken('secret', token, 'alice', 'thread-2', 'att-1'), false)
})
