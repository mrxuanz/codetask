import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { requireLocalhost } from '../../src/server/middleware/local-only'

function requestFrom(remoteAddress?: string, forwardedFor?: string): Promise<Response> {
  const app = new Hono()
  app.use('*', requireLocalhost)
  app.get('/mcp', (c) => c.json({ ok: true }))
  const env = remoteAddress
    ? {
        incoming: {
          socket: {
            remoteAddress,
            remotePort: 43127,
            remoteFamily: remoteAddress.includes(':') ? 'IPv6' : 'IPv4'
          }
        }
      }
    : {}
  return app.request(
    'http://localhost/mcp',
    forwardedFor ? { headers: { 'X-Forwarded-For': forwardedFor } } : undefined,
    env
  )
}

test('MCP localhost middleware accepts direct loopback peers', async () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal((await requestFrom(address)).status, 200, address)
  }
})

test('MCP localhost middleware rejects external, missing, and spoofed peers', async () => {
  assert.equal((await requestFrom('203.0.113.8')).status, 403)
  assert.equal((await requestFrom()).status, 403)
  assert.equal((await requestFrom('203.0.113.8', '127.0.0.1')).status, 403)
})
