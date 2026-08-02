import assert from 'node:assert/strict'
import test from 'node:test'
import { serve, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { requireAuth } from '../../src/server/middleware/require-auth'

function createSecuredApi(): Hono {
  const api = new Hono()
  api.use('*', requireAuth())
  api.get('/auth/bootstrap', (c) => c.json({ success: true, path: c.req.path }))
  api.get('/threads/:threadId/messages', (c) => c.json({ success: true }))
  api.get('/conversations/:conversationId/attachments/:attachmentId', (c) =>
    c.json({ success: true, assetToken: c.req.query('asset_token') ?? null })
  )
  api.get('/threads/:threadId/attachments/:attachmentId', (c) =>
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

let server: ServerType | null = null
let baseUrl = ''

async function startServer(withMcp = false): Promise<void> {
  const app = new Hono()
  app.route('/api', withMcp ? createApiWithMcp() : createSecuredApi())
  server = await new Promise<ServerType>((resolve, reject) => {
    const instance = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
    instance.once('listening', () => resolve(instance))
    instance.once('error', reject)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`
}

async function stopServer(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => (error ? reject(error) : resolve()))
    })
    server = null
  }
}

test('GET /api/auth/bootstrap is public without Authorization', async () => {
  await startServer()
  try {
    const response = await fetch(`${baseUrl}/api/auth/bootstrap`)
    assert.equal(response.status, 200)
    const body = (await response.json()) as { success: boolean; path: string }
    assert.equal(body.success, true)
    assert.equal(body.path, '/api/auth/bootstrap')
  } finally {
    await stopServer()
  }
})

test('GET /api/threads requires Authorization', async () => {
  await startServer()
  try {
    const response = await fetch(`${baseUrl}/api/threads/thread-1/messages?limit=1`)
    assert.equal(response.status, 401)
  } finally {
    await stopServer()
  }
})

test('GET /api/threads rejects query access_token without Authorization', async () => {
  await startServer()
  try {
    const response = await fetch(
      `${baseUrl}/api/threads/thread-1/messages?limit=1&access_token=query-token`
    )
    assert.equal(response.status, 401)
  } finally {
    await stopServer()
  }
})

test('GET /api/mcp/* is outside session Auth middleware', async () => {
  await startServer(true)
  try {
    const response = await fetch(`${baseUrl}/api/mcp/conversation/test-session?role=conversation`)
    assert.equal(response.status, 200)
    const body = (await response.json()) as { path: string }
    assert.equal(body.path, '/api/mcp/conversation/test-session')
  } finally {
    await stopServer()
  }
})

test('GET /api/conversations/:id/attachments/:id with asset_token bypasses Bearer auth', async () => {
  await startServer()
  try {
    const response = await fetch(
      `${baseUrl}/api/conversations/conv-1/attachments/att-1?asset_token=signed-token`
    )
    assert.equal(response.status, 200)
    const body = (await response.json()) as { assetToken: string | null }
    assert.equal(body.assetToken, 'signed-token')
  } finally {
    await stopServer()
  }
})

test('GET /api/conversations/:id/attachments/:id without auth or asset_token is rejected', async () => {
  await startServer()
  try {
    const response = await fetch(`${baseUrl}/api/conversations/conv-1/attachments/att-1`)
    assert.equal(response.status, 401)
  } finally {
    await stopServer()
  }
})

test('GET /api/threads/:id/attachments/:id with asset_token still bypasses Bearer auth', async () => {
  await startServer()
  try {
    const response = await fetch(
      `${baseUrl}/api/threads/thread-1/attachments/att-1?asset_token=signed-token`
    )
    assert.equal(response.status, 200)
    const body = (await response.json()) as { assetToken: string | null }
    assert.equal(body.assetToken, 'signed-token')
  } finally {
    await stopServer()
  }
})
