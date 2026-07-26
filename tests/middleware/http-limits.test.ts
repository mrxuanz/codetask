import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { Hono } from 'hono'
import {
  getRequestAbortSignal,
  REQUEST_TIMEOUT_MS,
  requestTimeout
} from '../../src/server/middleware/http-limits'
import { getCurrentRequestAbortSignal } from '../../src/server/context/request-abort'

test('requestTimeout returns 408 when handler exceeds limit', async () => {
  mock.timers.enable({ apis: ['setTimeout'], now: Date.now() })

  try {
    const app = new Hono()
    app.use('*', requestTimeout())
    app.get('/slow', async (c) => {
      const signal = getRequestAbortSignal(c)
      assert.equal(getCurrentRequestAbortSignal(), signal)
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', resolve, { once: true })
      )
      assert.equal(signal.aborted, true)
      return new Response('ok')
    })

    const responsePromise = app.fetch(new Request('http://localhost/slow'))
    mock.timers.tick(REQUEST_TIMEOUT_MS)
    const response = await responsePromise

    assert.equal(response.status, 408)
    const body = (await response.json()) as { status: number; message: string }
    assert.equal(body.status, 40801)
    assert.equal(body.message, 'Request timed out')
  } finally {
    mock.timers.reset()
  }
})

test('requestTimeout has no business-route bypasses', async () => {
  mock.timers.enable({ apis: ['setTimeout'], now: Date.now() })

  try {
    const app = new Hono()
    app.use('*', requestTimeout(10))
    app.get('/api/events/stream', async (c) => {
      const signal = getRequestAbortSignal(c)
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', resolve, { once: true })
      )
      return c.text('late')
    })

    const responsePromise = app.fetch(new Request('http://localhost/api/events/stream'))
    mock.timers.tick(10)

    assert.equal((await responsePromise).status, 408)
  } finally {
    mock.timers.reset()
  }
})
