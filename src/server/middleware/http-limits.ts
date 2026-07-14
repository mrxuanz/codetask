import type { MiddlewareHandler } from 'hono'
import type { SecurityContext } from '../context/types'
import { AppError } from '../error'
import { normalizedApiPath } from './require-auth'

export const REQUEST_TIMEOUT_MS = Number(process.env.CODETASK_REQUEST_TIMEOUT_MS ?? 300_000)
export const MAX_SSE_CLIENTS_PER_USER = Number(process.env.CODETASK_MAX_SSE_CLIENTS ?? 8)
export const MAX_CONCURRENT_TURNS_PER_USER = Number(process.env.CODETASK_MAX_CONCURRENT_TURNS ?? 2)

const SSE_STREAM_PATHS = new Set(['/events/stream', '/events/jobs/stream'])

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

export function requestTimeout(): MiddlewareHandler {
  return async (_c, next) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    timer.unref?.()

    try {
      if (controller.signal.aborted) {
        return requestTimedOut()
      }
      return await next()
    } catch (error) {
      if (controller.signal.aborted) {
        return requestTimedOut()
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}

export function assertConcurrentTurnCapacity(
  inflightForUser: number,
  max = MAX_CONCURRENT_TURNS_PER_USER
): void {
  if (inflightForUser >= max) {
    throw new AppError(
      42901,
      `At most ${max} concurrent turns allowed`,
      { error: `At most ${max} concurrent turns allowed`, turnErrorCode: 'conversation.concurrent_turn_limit' },
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
