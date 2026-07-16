import type { MiddlewareHandler } from 'hono'
import type { SecurityContext } from '../context/types'
import { AppError } from '../error'
import { runWithRequestAbortSignal } from '../context/request-abort'
import { normalizedApiPath } from './require-auth'
import { DEFAULT_APP_CONFIG } from '../config/app-config'

declare module 'hono' {
  interface ContextVariableMap {
    requestAbortSignal: AbortSignal
  }
}

export const REQUEST_TIMEOUT_MS = DEFAULT_APP_CONFIG.http.requestTimeoutMs
export const MAX_SSE_CLIENTS_PER_USER = DEFAULT_APP_CONFIG.http.maxSseClientsPerUser
export const MAX_CONCURRENT_TURNS_PER_USER = DEFAULT_APP_CONFIG.http.maxConcurrentTurnsPerUser

const SSE_STREAM_PATHS = new Set([
  '/events/stream',
  '/events/jobs/stream',
  '/realtime/stream'
])

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

function isLongLivedSsePath(path: string): boolean {
  return isSseStreamRoute(path)
}

export function requestTimeout(timeoutMs = REQUEST_TIMEOUT_MS): MiddlewareHandler {
  return async (c, next) => {
    if (isLongLivedSsePath(c.req.path)) {
      return next()
    }

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

/**
 * Downstream work can use this signal to stop DB/provider work when a normal
 * HTTP request times out. Long-lived SSE routes deliberately bypass this
 * middleware and keep their own lifecycle signal.
 */
export function getRequestAbortSignal(c: {
  get(key: 'requestAbortSignal'): AbortSignal | undefined
}): AbortSignal {
  return c.get('requestAbortSignal') ?? new AbortController().signal
}

export function assertConcurrentTurnCapacity(
  inflightForUser: number,
  max = MAX_CONCURRENT_TURNS_PER_USER
): void {
  if (inflightForUser >= max) {
    throw new AppError(
      42901,
      `At most ${max} concurrent turns allowed`,
      {
        error: `At most ${max} concurrent turns allowed`,
        turnErrorCode: 'conversation.concurrent_turn_limit'
      },
      429
    )
  }
}

export function countActiveSseClientsForUser(
  activeByKey: Iterable<string>,
  username: string
): number {
  const prefix = `${username}::`
  let count = 0
  for (const key of activeByKey) {
    if (key.startsWith(prefix)) count++
  }
  return count
}

export function assertSseClientCapacity(
  activeByKey: Iterable<string>,
  username: string,
  max = MAX_SSE_CLIENTS_PER_USER
): void {
  const active = countActiveSseClientsForUser(activeByKey, username)
  if (active >= max) {
    throw new AppError(
      42901,
      `At most ${max} SSE clients allowed`,
      { error: `At most ${max} SSE clients allowed`, turnErrorCode: 'events.sse_client_limit' },
      429
    )
  }
}

export function isSseStreamRoute(path: string): boolean {
  return SSE_STREAM_PATHS.has(normalizedApiPath(path))
}

export function httpResourceLimits(_security: SecurityContext): MiddlewareHandler {
  return async (_c, next) => next()
}
