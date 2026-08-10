import type { MiddlewareHandler } from 'hono'
import type { SecurityContext } from '../context/types'

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function originForbidden(message: string, requestId: string): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: {
        code: 'auth.origin_forbidden',
        message,
        details: { turnErrorCode: 'auth.origin_forbidden' }
      },
      requestId
    }),
    { status: 403, headers: { 'Content-Type': 'application/json' } }
  )
}

function parseAuthority(hostHeader: string): { authority: string; hostname: string } | null {
  const trimmed = hostHeader.trim()
  if (!trimmed) return null
  try {
    const parsed = new URL(`http://${trimmed}`)
    return { authority: parsed.host.toLowerCase(), hostname: parsed.hostname.toLowerCase() }
  } catch {
    return null
  }
}

function parseOrigin(originHeader: string): { authority: string; hostname: string } | null {
  const trimmed = originHeader.trim()
  if (!trimmed) return null
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return { authority: parsed.host.toLowerCase(), hostname: parsed.hostname.toLowerCase() }
  } catch {
    return null
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase()
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
    const host = parseAuthority(hostHeader)

    if (security.mode === 'desktop') {
      if (host && !isLoopbackHost(host.hostname)) {
        return originForbidden(
          'External host not allowed in desktop mode',
          c.get('requestId') ?? 'unknown'
        )
      }
    }

    if (WRITE_METHODS.has(c.req.method)) {
      const originHeader = c.req.header('Origin') ?? ''
      const origin = parseOrigin(originHeader)

      if (originHeader && !origin) {
        return originForbidden('Invalid Origin header', c.get('requestId') ?? 'unknown')
      }
      if (origin) {
        if (security.mode === 'desktop') {
          if (!isLoopbackHost(origin.hostname)) {
            return originForbidden(
              'Cross-origin write requests not allowed',
              c.get('requestId') ?? 'unknown'
            )
          }
        }

        const sameOriginAsHost = Boolean(host && origin.authority === host.authority)
        if (!sameOriginAsHost) {
          return originForbidden(
            'Cross-origin write requests not allowed',
            c.get('requestId') ?? 'unknown'
          )
        }
      }
    }

    return next()
  }
}
