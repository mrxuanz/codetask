import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { requireAuth } from '../../src/server/middleware/require-auth'

function createSecuredApi(): Hono {
  const api = new Hono()
  api.use('*', requireAuth())
  api.get('/auth/bootstrap', (c) => c.json({ success: true, path: c.req.path }))
  api.get('/conversations/:conversationId/messages', (c) => c.json({ success: true }))
  api.get('/conversations/:conversationId/attachments/:attachmentId', (c) =>
    c.json({ success: true, assetToken: c.req.query('asset_token') ?? null })
  )
  return api
}

/** MCP is mounted outside session Auth (own protocol boundary). */
function createApiWithMcp(): Hono {
  const api = new Hono()
  api.get('/mcp/conversation/:sessionId', (c) => c.json({ success: true, path: c.req.path }))
  api.route('/', createSecuredApi())
  return api
}

function createTestApp(withMcp = false): Hono {
  const app = new Hono()
  app.route('/api', withMcp ? createApiWithMcp() : createSecuredApi())
  return app
}

test('GET /api/auth/bootstrap is public without Authorization', async () => {
  const response = await createTestApp().request('http://local.test/api/auth/bootstrap')
  assert.equal(response.status, 200)
  const body = (await response.json()) as { success: boolean; path: string }
  assert.equal(body.success, true)
  assert.equal(body.path, '/api/auth/bootstrap')
})

test('GET /api/conversations requires Authorization', async () => {
  const response = await createTestApp().request(
    'http://local.test/api/conversations/conversation-1/messages?limit=1'
  )
  assert.equal(response.status, 401)
})

test('GET /api/conversations rejects query access_token without Authorization', async () => {
  const response = await createTestApp().request(
    'http://local.test/api/conversations/conversation-1/messages?limit=1&access_token=query-token'
  )
  assert.equal(response.status, 401)
})

test('GET /api/mcp/* is outside session Auth middleware', async () => {
  const response = await createTestApp(true).request(
    'http://local.test/api/mcp/conversation/test-session?role=conversation'
  )
  assert.equal(response.status, 200)
  const body = (await response.json()) as { path: string }
  assert.equal(body.path, '/api/mcp/conversation/test-session')
})

test('GET /api/conversations/:id/attachments/:id with asset_token bypasses Bearer auth', async () => {
  const response = await createTestApp().request(
    'http://local.test/api/conversations/conversation-1/attachments/attachment-1?asset_token=signed-token'
  )
  assert.equal(response.status, 200)
  const body = (await response.json()) as { assetToken: string | null }
  assert.equal(body.assetToken, 'signed-token')
})

test('GET /api/conversations/:id/attachments/:id without auth or asset_token is rejected', async () => {
  const response = await createTestApp().request(
    'http://local.test/api/conversations/conversation-1/attachments/attachment-1'
  )
  assert.equal(response.status, 401)
})
