import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isAttachmentAssetTokenGet,
  isPublicApiRoute,
  normalizedApiPath
} from '../../src/server/middleware/require-auth'
import { resolveSessionTokenFromRequest } from '../../src/server/auth/session'

test('normalizedApiPath strips /api prefix and query string', () => {
  assert.equal(normalizedApiPath('/api/auth/bootstrap'), '/auth/bootstrap')
  assert.equal(
    normalizedApiPath('/api/threads/t1/attachments/a1?access_token=abc'),
    '/threads/t1/attachments/a1'
  )
  assert.equal(normalizedApiPath('/threads/t1/attachments/a1'), '/threads/t1/attachments/a1')
})

test('isPublicApiRoute includes auth bootstrap routes under /api/auth', () => {
  assert.equal(isPublicApiRoute('GET', '/api/auth/bootstrap'), true)
  assert.equal(isPublicApiRoute('POST', '/api/auth/login'), true)
  assert.equal(isPublicApiRoute('POST', '/api/auth/setup'), true)
  assert.equal(isPublicApiRoute('POST', '/api/auth/captcha'), true)
  assert.equal(isPublicApiRoute('GET', '/auth/bootstrap'), true)
  assert.equal(isPublicApiRoute('POST', '/auth/login'), true)
  assert.equal(isPublicApiRoute('GET', '/bootstrap'), false)
  assert.equal(isPublicApiRoute('POST', '/login'), false)
  assert.equal(isPublicApiRoute('GET', '/api/threads/t1/messages'), false)
})

test('isAttachmentAssetTokenGet allows asset_token attachment reads under /api', () => {
  assert.equal(
    isAttachmentAssetTokenGet('GET', '/api/conversations/c1/attachments/a1', 'tok'),
    true
  )
  assert.equal(isAttachmentAssetTokenGet('GET', '/conversations/c1/attachments/a1', 'tok'), true)
  assert.equal(isAttachmentAssetTokenGet('GET', '/api/threads/t1/attachments/a1', 'tok'), true)
  assert.equal(isAttachmentAssetTokenGet('GET', '/api/conversations/c1/attachments/a1', ''), false)
  assert.equal(
    isAttachmentAssetTokenGet('POST', '/api/conversations/c1/attachments/a1', 'tok'),
    false
  )
})

test('resolveSessionTokenFromRequest accepts only Authorization headers', () => {
  assert.equal(
    resolveSessionTokenFromRequest({
      authHeader: 'Bearer header-token',
      accessToken: 'query-token'
    }),
    'header-token'
  )
  assert.equal(
    resolveSessionTokenFromRequest({
      accessToken: 'query-token'
    }),
    undefined
  )
})
