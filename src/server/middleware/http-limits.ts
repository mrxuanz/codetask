import type { MiddlewareHandler } from 'hono'
import { runWithRequestAbortSignal } from '../context/request-abort'

declare module 'hono' {
  interface ContextVariableMap {
    requestAbortSignal: AbortSignal
  }
}

export const REQUEST_TIMEOUT_MS = 30_000

function requestTimedOut(): Response {
  return new Response(
    JSON.stringify({
      data: null,
      status: 40801,
      extra: {},
      message: 'Request timed out',
      success: false
    }),
    {
      status: 408,
      headers: { 'Content-Type': 'application/json' }
    }
  )
}

export function requestTimeout(timeoutMs = REQUEST_TIMEOUT_MS): MiddlewareHandler {
  return async (c, next) => {
    const controller = new AbortController()
    c.set('requestAbortSignal', controller.signal)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<Response>((resolve) => {
      timer = setTimeout(() => {
        resolve(requestTimedOut())
        // Resolve the outer race first so a cooperative handler that observes
        // this abort cannot win the response race with a late 200 response.
        queueMicrotask(() => controller.abort(new Error('request.timeout')))
      }, timeoutMs)
      timer.unref?.()
    })

    try {
      const downstream = runWithRequestAbortSignal(controller.signal, () => next())
      return await Promise.race([downstream, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

/** Downstream work can cooperatively stop when the HTTP request times out. */
export function getRequestAbortSignal(c: {
  get(key: 'requestAbortSignal'): AbortSignal | undefined
}): AbortSignal {
  return c.get('requestAbortSignal') ?? new AbortController().signal
}
