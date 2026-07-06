import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isAttachmentAssetTokenGet,
  isMcpApiRoute,
  isPublicApiRoute,
  normalizedApiPath
} from '../../src/server/middleware/require-auth'
import { resolveSessionTokenFromRequest } from '../../src/server/auth/session'

test('normalizedApiPath strips /api prefix and query string', () => {
  assert.equal(normalizedApiPath('/api/bootstrap'), '/bootstrap')
  assert.equal(
    normalizedApiPath('/api/threads/t1/attachments/a1?access_token=abc'),
    '/threads/t1/attachments/a1'
  )
  assert.equal(normalizedApiPath('/threads/t1/attachments/a1'), '/threads/t1/attachments/a1')
})

test('isMcpApiRoute matches MCP subpaths with /api prefix', () => {
  assert.equal(isMcpApiRoute('/api/mcp'), true)
  assert.equal(isMcpApiRoute('/api/mcp/task/session-1'), true)
  assert.equal(isMcpApiRoute('/api/threads/t1/mcp'), false)
  assert.equal(isMcpApiRoute('/mcp'), true)
})

test('isPublicApiRoute includes auth bootstrap routes under /api', () => {
  assert.equal(isPublicApiRoute('GET', '/api/bootstrap'), true)
  assert.equal(isPublicApiRoute('POST', '/api/login'), true)
  assert.equal(isPublicApiRoute('POST', '/api/setup'), true)
  assert.equal(isPublicApiRoute('GET', '/bootstrap'), true)
  assert.equal(isPublicApiRoute('POST', '/login'), true)
  assert.equal(isPublicApiRoute('GET', '/api/threads/t1/messages'), false)
})

test('isAttachmentAssetTokenGet allows asset_token attachment reads under /api', () => {
  assert.equal(isAttachmentAssetTokenGet('GET', '/api/threads/t1/attachments/a1', 'tok'), true)
  assert.equal(isAttachmentAssetTokenGet('GET', '/threads/t1/attachments/a1', 'tok'), true)
  assert.equal(isAttachmentAssetTokenGet('GET', '/api/threads/t1/attachments/a1', ''), false)
  assert.equal(isAttachmentAssetTokenGet('POST', '/api/threads/t1/attachments/a1', 'tok'), false)
})

test('resolveSessionTokenFromRequest prefers Authorization header', () => {
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
    'query-token'
  )
})
