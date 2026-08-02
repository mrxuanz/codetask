import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHonoApp } from '@codetask/server-core'
import { Hono } from 'hono'

describe('host parity (01)', () => {
  it('createHonoApp mounts a single /api surface for desktop and service hosts', async () => {
    const api = new Hono()
    api.get('/health', (c) => c.json({ success: true, data: { status: 'ok' } }))
    const app = createHonoApp({
      isDev: true,
      rendererDevUrl: 'http://127.0.0.1:5173',
      api
    })
    const res = await app.request('http://127.0.0.1/api/health')
    assert.equal(res.status, 200)
    const body = (await res.json()) as { data?: { status?: string } }
    assert.equal(body.data?.status, 'ok')
  })

  it('apps/service entry imports without requiring out/', async () => {
    const fs = await import('node:fs')
    assert.equal(fs.existsSync('out/main/standalone.js'), false)
    const source = fs.readFileSync('apps/service/src/main.ts', 'utf8')
    assert.match(source, /startAppServer/)
    assert.match(source, /rendererDevUrl/)
  })
})
