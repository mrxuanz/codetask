import type { MiddlewareHandler } from 'hono'
import type { SecurityContext } from '../context/types'

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function isLoopbackHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase()
  return (
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '::ffff:127.0.0.1' ||
    normalized === 'localhost'
  )
}

function parseHostHeader(hostHeader: string): string | null {
  if (!hostHeader) return null
  try {
    return new URL(`http://${hostHeader}`).hostname
  } catch {
    return null
  }
}

export function requestGuard(security: SecurityContext): MiddlewareHandler {
  return async (c, next) => {
    const hostHeader = c.req.header('Host') ?? ''
    const host = parseHostHeader(hostHeader)

    if (security.mode === 'desktop') {
      if (!host || !isLoopbackHost(host)) {
        return forbidden('External host not allowed in desktop mode')
      }
    }

    if (WRITE_METHODS.has(c.req.method)) {
      const originHeader = c.req.header('Origin') ?? ''
      const fetchSite = c.req.header('Sec-Fetch-Site')?.toLowerCase()
      if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
        return forbidden('Cross-origin write requests not allowed')
      }

      if (originHeader) {
        let origin: URL
        let requestUrl: URL
        try {
          origin = new URL(originHeader)
          requestUrl = new URL(c.req.url)
        } catch {
          return forbidden('Invalid request origin')
        }

        if (origin.origin !== requestUrl.origin) {
          return forbidden('Cross-origin write requests not allowed')
        }
      }
    }

    return next()
  }
}

function forbidden(message: string): Response {
  return new Response(
    JSON.stringify({
      data: null,
      status: 40301,
      extra: {},
      message,
      success: false
    }),
    {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    }
  )
}
