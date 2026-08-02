import type { MiddlewareHandler } from 'hono'
import type { SecurityContext } from '../context/types'

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function isLoopbackHost(host: string): boolean {
  const normalized = host.split(':')[0]?.toLowerCase() ?? ''
  return (
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '::ffff:127.0.0.1' ||
    normalized === 'localhost'
  )
}

/**
 * Host / Origin guard for session-authenticated API routes.
 * MCP is mounted outside this middleware (own protocol boundary).
 */
export function requestGuard(security: SecurityContext): MiddlewareHandler {
  return async (c, next) => {
    const hostHeader = c.req.header('Host') ?? ''
    const host = hostHeader.split(':')[0]?.toLowerCase() ?? ''

    if (security.mode === 'desktop') {
      if (host && !isLoopbackHost(host)) {
        return new Response(
          JSON.stringify({
            data: {
              error: 'External host not allowed in desktop mode',
              code: 'auth.origin_forbidden',
              turnErrorCode: 'auth.origin_forbidden'
            },
            status: 40301,
            extra: {},
            message: 'auth.origin_forbidden',
            success: false
          }),
          {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
          }
        )
      }
    }

    if (WRITE_METHODS.has(c.req.method)) {
      const originHeader = c.req.header('Origin') ?? ''
      const origin = originHeader.split('/').slice(0, 3).join('/')

      if (origin) {
        const originHost =
          origin
            .replace(/^https?:\/\//, '')
            .split(':')[0]
            ?.toLowerCase() ?? ''

        if (security.mode === 'desktop') {
          if (!isLoopbackHost(originHost)) {
            return new Response(
              JSON.stringify({
                data: {
                  error: 'Cross-origin write requests not allowed',
                  code: 'auth.origin_forbidden',
                  turnErrorCode: 'auth.origin_forbidden'
                },
                status: 40301,
                extra: {},
                message: 'auth.origin_forbidden',
                success: false
              }),
              {
                status: 403,
                headers: { 'Content-Type': 'application/json' }
              }
            )
          }
        }

        if (security.mode === 'server') {
          const sameOriginAsHost = Boolean(host && originHost === host)
          if (!sameOriginAsHost) {
            return new Response(
              JSON.stringify({
                data: {
                  error: 'Cross-origin write requests not allowed',
                  code: 'auth.origin_forbidden',
                  turnErrorCode: 'auth.origin_forbidden'
                },
                status: 40301,
                extra: {},
                message: 'auth.origin_forbidden',
                success: false
              }),
              {
                status: 403,
                headers: { 'Content-Type': 'application/json' }
              }
            )
          }
        }
      }
    }

    return next()
  }
}
