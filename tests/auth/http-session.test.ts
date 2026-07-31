import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  createCsrfToken,
  issueSessionCookies,
  verifyCsrfToken
} from '../../src/server/auth/http-session'
import { requireUsername } from '../../src/server/auth/session'
import { requireAuth } from '../../src/server/middleware/require-auth'
import type { SecurityContext } from '../../src/server/context/types'

const SECRET = 'b'.repeat(64)

function security(): SecurityContext {
  return {
    mode: 'desktop',
    authSecret: SECRET,
    auth: {
      authenticateToken(token: string) {
        return token === 'session-token'
          ? {
              userId: 'user-1',
              username: 'ops_user',
              sessionId: 'session-1',
              expiresAtMs: Date.now() + 60_000
            }
          : null
      }
    }
  } as unknown as SecurityContext
}

function app(): Hono {
  const app = new Hono()
  app.use('*', requireAuth(security()))
  app.post('/projects', async (c) => c.json({ username: await requireUsername() }))
  return app
}

test('CSRF tokens are signed by the database auth secret', () => {
  const token = createCsrfToken(SECRET)
  assert.equal(verifyCsrfToken(SECRET, token), true)
  assert.equal(verifyCsrfToken('different-secret', token), false)
  assert.equal(verifyCsrfToken(SECRET, `${token}x`), false)
})

test('cookie-authenticated writes require a matching signed CSRF token', async () => {
  const csrf = createCsrfToken(SECRET)
  const cookie = `${SESSION_COOKIE}=session-token; ${CSRF_COOKIE}=${csrf}`

  const rejected = await app().request('/projects', {
    method: 'POST',
    headers: { Cookie: cookie }
  })
  assert.equal(rejected.status, 403)

  const accepted = await app().request('/projects', {
    method: 'POST',
    headers: {
      Cookie: cookie,
      [CSRF_HEADER]: csrf
    }
  })
  assert.equal(accepted.status, 200)
  assert.deepEqual(await accepted.json(), { username: 'ops_user' })
})

test('explicit Bearer clients do not use browser CSRF protection', async () => {
  const response = await app().request('/projects', {
    method: 'POST',
    headers: { Authorization: 'Bearer session-token' }
  })
  assert.equal(response.status, 200)
})

test('cookie security follows the request URL without public-origin environment configuration', async () => {
  const cookieApp = new Hono()
  cookieApp.get('/issue', (c) => {
    issueSessionCookies(c, {
      token: 'session-token',
      expiresAtSec: Math.floor(Date.now() / 1000) + 60,
      authSecret: SECRET
    })
    return c.text('ok')
  })

  const httpCookies = (await cookieApp.request('http://localhost/issue')).headers.get('set-cookie')
  const httpsCookies = (await cookieApp.request('https://localhost/issue')).headers.get(
    'set-cookie'
  )
  assert.doesNotMatch(httpCookies ?? '', /;\s*Secure/iu)
  assert.match(httpsCookies ?? '', /;\s*Secure/iu)
})
