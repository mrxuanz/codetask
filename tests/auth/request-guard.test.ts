import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import type { SecurityContext } from '../../src/server/context/types'
import { requestGuard } from '../../src/server/middleware/request-guard'

function app(mode: SecurityContext['mode']): Hono {
  const app = new Hono()
  app.use('*', requestGuard({ mode } as SecurityContext))
  app.post('/write', (c) => c.json({ ok: true }))
  return app
}

test('server writes use the request Host as their origin boundary', async () => {
  const accepted = await app('server').request('http://service.example/write', {
    method: 'POST',
    headers: {
      Host: 'service.example',
      Origin: 'http://service.example'
    }
  })
  assert.equal(accepted.status, 200)

  const rejected = await app('server').request('http://service.example/write', {
    method: 'POST',
    headers: {
      Host: 'service.example',
      Origin: 'http://attacker.example'
    }
  })
  assert.equal(rejected.status, 403)
})
