import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { Hono } from 'hono'
import {
  isSseStreamRoute,
  getRequestAbortSignal,
  REQUEST_TIMEOUT_MS,
  requestTimeout
} from '../../src/server/middleware/http-limits'
import { getCurrentRequestAbortSignal } from '../../src/server/context/request-abort'

test('isSseStreamRoute recognizes known SSE stream paths', () => {
  assert.equal(isSseStreamRoute('/api/events/stream'), true)
  assert.equal(isSseStreamRoute('/api/events/jobs/stream'), true)
  assert.equal(isSseStreamRoute('/api/threads/thread-1/messages'), false)
})

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

test('requestTimeout skips long-lived SSE and conversation message routes', async () => {
  mock.timers.enable({ apis: ['setTimeout'], now: Date.now() })

  try {
    const app = new Hono()
    app.use('*', requestTimeout())
    app.get('/api/events/stream', async (c) => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, REQUEST_TIMEOUT_MS + 1_000)
      })
      return c.text('stream')
    })
    app.get('/api/threads/thread-1/messages', async (c) => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, REQUEST_TIMEOUT_MS + 1_000)
      })
      return c.text('messages')
    })

    const streamResponsePromise = app.fetch(new Request('http://localhost/api/events/stream'))
    const messagesResponsePromise = app.fetch(
      new Request('http://localhost/api/threads/thread-1/messages')
    )
    mock.timers.tick(REQUEST_TIMEOUT_MS + 1_000)

    const streamResponse = await streamResponsePromise
    const messagesResponse = await messagesResponsePromise

    assert.equal(streamResponse.status, 200)
    assert.equal(messagesResponse.status, 200)
  } finally {
    mock.timers.reset()
  }
})
