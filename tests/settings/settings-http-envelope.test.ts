import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { createSettingsHttpRoutes } from '../../packages/server-core/src/modules/settings/http/settings-routes.ts'

test('settings validation errors use a standard ApiFailure envelope', async () => {
  const settings = createSettingsHttpRoutes({
    app: {} as never,
    requireAuth: () => undefined,
    ok: (data) => ({ success: true, data, requestId: 'success-id' }),
    badRequest: () => {
      throw new Error('unexpected badRequest callback')
    },
    conflict: () => {
      throw new Error('unexpected conflict callback')
    },
    getEffectiveProviders: () => ({ providers: {} })
  })
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('requestId' as never, 'request-123')
    await next()
  })
  app.route('/settings', settings)

  const response = await app.request('/settings/agent-defaults', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({})
  })
  const body = await response.json()

  assert.equal(response.status, 400)
  assert.deepEqual(body, {
    success: false,
    error: {
      code: 'settings.invalid_payload',
      message: 'expectedRevision must be a non-negative integer',
      details: { code: 'settings.invalid_payload' }
    },
    requestId: 'request-123'
  })
})
