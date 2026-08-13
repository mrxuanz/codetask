import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import type { SecurityContext } from '../../src/server/context/types'
import { requestGuard } from '../../src/server/middleware/request-guard'

function app(mode: SecurityContext['mode']): Hono {
  const app = new Hono()
  app.use('*', requestGuard({ mode } as SecurityContext))
  app.get('/read', (c) => c.json({ ok: true }))
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

  const wrongPort = await app('server').request('http://service.example:8080/write', {
    method: 'POST',
    headers: {
      Host: 'service.example:8080',
      Origin: 'http://service.example:9090'
    }
  })
  assert.equal(wrongPort.status, 403)

  const wrongProtocol = await app('server').request('https://service.example/write', {
    method: 'POST',
    headers: { Host: 'service.example', Origin: 'http://service.example' }
  })
  assert.equal(wrongProtocol.status, 403)
})

test('desktop writes require the same loopback host and port', async () => {
  const accepted = await app('desktop').request('http://127.0.0.1:43127/write', {
    method: 'POST',
    headers: { Host: '127.0.0.1:43127', Origin: 'http://127.0.0.1:43127' }
  })
  assert.equal(accepted.status, 200)

  const rejected = await app('desktop').request('http://127.0.0.1:43127/write', {
    method: 'POST',
    headers: { Host: '127.0.0.1:43127', Origin: 'http://127.0.0.1:5173' }
  })
  assert.equal(rejected.status, 403)
})

test('desktop Host parsing fails closed and accepts every loopback representation', async () => {
  for (const host of [
    '127.0.0.1:43127',
    'localhost:43127',
    '[::1]:43127',
    '[::ffff:127.0.0.1]:43127'
  ]) {
    const response = await app('desktop').request(`http://${host}/read`, {
      headers: { Host: host }
    })
    assert.equal(response.status, 200, host)
  }

  for (const host of ['', 'not a host', 'example.test', '127.0.0.1/path', 'user@127.0.0.1']) {
    const response = await app('desktop').request('http://127.0.0.1/read', {
      headers: { Host: host }
    })
    assert.equal(response.status, 403, JSON.stringify(host))
  }
})

test('writes reject malformed Origin values while requests without Origin remain CSRF-owned', async () => {
  const malformed = await app('desktop').request('http://127.0.0.1:43127/write', {
    method: 'POST',
    headers: { Host: '127.0.0.1:43127', Origin: 'http://127.0.0.1:43127/path' }
  })
  assert.equal(malformed.status, 403)

  const noOrigin = await app('desktop').request('http://127.0.0.1:43127/write', {
    method: 'POST',
    headers: { Host: '127.0.0.1:43127' }
  })
  assert.equal(noOrigin.status, 200)
})
