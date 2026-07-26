import assert from 'node:assert/strict'
import test from 'node:test'
import { isPublicApiRoute, normalizedApiPath } from '../../src/server/middleware/require-auth'

test('normalizedApiPath strips /api prefix and query string', () => {
  assert.equal(normalizedApiPath('/api/bootstrap'), '/bootstrap')
  assert.equal(normalizedApiPath('/api/sandbox/health?probe=1'), '/sandbox/health')
  assert.equal(normalizedApiPath('/sandbox/health'), '/sandbox/health')
})

test('isPublicApiRoute includes auth bootstrap routes under /api', () => {
  assert.equal(isPublicApiRoute('GET', '/api/bootstrap'), true)
  assert.equal(isPublicApiRoute('POST', '/api/login'), true)
  assert.equal(isPublicApiRoute('POST', '/api/setup'), true)
  assert.equal(isPublicApiRoute('GET', '/bootstrap'), true)
  assert.equal(isPublicApiRoute('POST', '/login'), true)
  assert.equal(isPublicApiRoute('GET', '/api/sandbox/health'), false)
})

test('the public allowlist never includes protected data routes', () => {
  assert.equal(isPublicApiRoute('GET', '/api/sandbox/health?access_token=forged'), false)
  assert.equal(isPublicApiRoute('POST', '/api/logout'), false)
  assert.equal(isPublicApiRoute('POST', '/api/change-password'), false)
})
