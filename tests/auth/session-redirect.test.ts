import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldClearSessionOnApiError } from '../../src/renderer/src/auth/sessionRedirect'

test('shouldClearSessionOnApiError keeps session on login guard responses', () => {
  assert.equal(
    shouldClearSessionOnApiError(401, 40101, 'Captcha required', { captchaRequired: true }),
    false
  )
  assert.equal(
    shouldClearSessionOnApiError(401, 40101, 'Account temporarily locked', {
      lockedUntil: 123,
      retryAfterSec: 60
    }),
    false
  )
})

test('shouldClearSessionOnApiError keeps session on HTTP 429', () => {
  assert.equal(shouldClearSessionOnApiError(429, 40101, 'Too many captcha requests', null), false)
})

test('shouldClearSessionOnApiError clears session on expired session', () => {
  assert.equal(shouldClearSessionOnApiError(401, 40101, 'Invalid or expired session', null), true)
  assert.equal(shouldClearSessionOnApiError(401, 40101, '会话已过期', null), true)
})
