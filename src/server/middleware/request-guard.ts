import type { MiddlewareHandler } from 'hono'
import type { SecurityContext } from '../context/types'
import { processHostEnvironmentSource } from '../host-environment'
import { isMcpApiRoute } from './require-auth'

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

export function requestGuard(security: SecurityContext): MiddlewareHandler {
  const publicOrigin = processHostEnvironmentSource.snapshot().CODETASK_PUBLIC_ORIGIN?.trim()

  return async (c, next) => {
    if (isMcpApiRoute(c.req.path)) {
      return next()
    }

    const hostHeader = c.req.header('Host') ?? ''
    const host = hostHeader.split(':')[0]?.toLowerCase() ?? ''

    if (security.mode === 'desktop') {
      if (host && !isLoopbackHost(host)) {
        return new Response(
          JSON.stringify({
            data: null,
            status: 40301,
            extra: {},
            message: 'External host not allowed in desktop mode',
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
                data: null,
                status: 40301,
                extra: {},
                message: 'Cross-origin write requests not allowed',
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
          const publicHost = publicOrigin
            ? publicOrigin
                .replace(/^https?:\/\//, '')
                .split(':')[0]
                ?.toLowerCase()
            : null
          const sameOriginAsHost = Boolean(host && originHost === host)
          const allowed =
            (publicHost !== null && originHost === publicHost) ||
            isLoopbackHost(originHost) ||
            sameOriginAsHost

          if (!allowed) {
            return new Response(
              JSON.stringify({
                data: null,
                status: 40301,
                extra: {},
                message: 'Cross-origin write requests not allowed',
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
