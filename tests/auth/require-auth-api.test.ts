import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import type { SecureAuthModule } from '../../src/server/composition/auth'
import { requireAuth } from '../../src/server/middleware/require-auth'

const SESSION_TOKEN = 'a'.repeat(43)
const CSRF_TOKEN = 'b'.repeat(64)

function fakeAuthModule(): SecureAuthModule {
  return {
    service: {
      tryAuthenticate(token: string) {
        return token === SESSION_TOKEN
          ? {
              userId: 'user-1',
              username: 'alice',
              sessionId: 'session-1',
              expiresAtMs: Date.now() + 60_000
            }
          : null
      }
    },
    verifyCsrfToken(sessionToken: string, csrfToken: string) {
      return sessionToken === SESSION_TOKEN && csrfToken === CSRF_TOKEN
    }
  } as unknown as SecureAuthModule
}

function createTestApp(): Hono {
  const api = new Hono()
  api.use('*', requireAuth(fakeAuthModule()))
  api.get('/bootstrap', (c) => c.json({ success: true, path: c.req.path }))
  api.get('/sandbox/health', (c) => c.json({ success: true }))
  api.post('/change-password', (c) => c.json({ success: true }))

  const app = new Hono()
  app.route('/api', api)
  return app
}

test('GET /api/bootstrap is public without a session', async () => {
  const response = await createTestApp().request('/api/bootstrap')
  assert.equal(response.status, 200)
  const body = (await response.json()) as { success: boolean; path: string }
  assert.equal(body.success, true)
  assert.equal(body.path, '/api/bootstrap')
})

test('GET /api/sandbox/health requires a session cookie', async () => {
  const response = await createTestApp().request('/api/sandbox/health')
  assert.equal(response.status, 401)
})

test('GET /api/sandbox/health accepts a valid session cookie', async () => {
  const response = await createTestApp().request('/api/sandbox/health', {
    headers: { Cookie: `codetask_session=${SESSION_TOKEN}` }
  })
  assert.equal(response.status, 200)
})

test('state-changing cookie request requires matching CSRF cookie and header', async () => {
  const app = createTestApp()
  const withoutCsrf = await app.request('/api/change-password', {
    method: 'POST',
    headers: { Cookie: `codetask_session=${SESSION_TOKEN}` }
  })
  assert.equal(withoutCsrf.status, 403)

  const withCsrf = await app.request('/api/change-password', {
    method: 'POST',
    headers: {
      Cookie: `codetask_session=${SESSION_TOKEN}; codetask_csrf=${CSRF_TOKEN}`,
      'x-codetask-csrf': CSRF_TOKEN
    }
  })
  assert.equal(withCsrf.status, 200)
})

test('Bearer credentials are not accepted by the browser session boundary', async () => {
  const response = await createTestApp().request('/api/sandbox/health', {
    headers: { Authorization: `Bearer ${SESSION_TOKEN}` }
  })
  assert.equal(response.status, 401)
})

test('query access_token is rejected for protected data routes', async () => {
  const response = await createTestApp().request('/api/sandbox/health?access_token=query-token')
  assert.equal(response.status, 401)
})
