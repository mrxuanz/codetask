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

function normalizeHostname(hostname: string): string {
  const normalized = hostname.toLowerCase()
  return normalized.startsWith('[') && normalized.endsWith(']')
    ? normalized.slice(1, -1)
    : normalized
}

function parseAuthority(hostHeader: string): { authority: string; hostname: string } | null {
  const trimmed = hostHeader.trim()
  if (!trimmed || /[\s/@?#]/.test(trimmed)) return null
  try {
    const parsed = new URL(`http://${trimmed}`)
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      return null
    }
    return {
      authority: parsed.host.toLowerCase(),
      hostname: normalizeHostname(parsed.hostname)
    }
  } catch {
    return null
  }
}

function parseOrigin(
  originHeader: string
): { authority: string; hostname: string; protocol: string } | null {
  const trimmed = originHeader.trim()
  if (!trimmed) return null
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      return null
    }
    return {
      authority: parsed.host.toLowerCase(),
      hostname: normalizeHostname(parsed.hostname),
      protocol: parsed.protocol
    }
  } catch {
    return null
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase()
  const ipv4Parts = normalized.split('.')
  const isIpv4Loopback =
    ipv4Parts.length === 4 &&
    ipv4Parts[0] === '127' &&
    ipv4Parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  const mappedIpv4 = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  const isMappedIpv4Loopback = Boolean(
    mappedIpv4 && Number.parseInt(mappedIpv4[1], 16) >> 8 === 127
  )
  return (
    isIpv4Loopback ||
    normalized === '::1' ||
    (normalized.startsWith('::ffff:') && isLoopbackHost(normalized.slice('::ffff:'.length))) ||
    isMappedIpv4Loopback ||
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
      if (!host || !isLoopbackHost(host.hostname)) {
        return originForbidden(
          'A valid loopback Host is required in desktop mode',
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

        let requestProtocol: string | null = null
        try {
          requestProtocol = new URL(c.req.url).protocol
        } catch {
          requestProtocol = null
        }
        const sameOriginAsHost = Boolean(
          host &&
          requestProtocol &&
          origin.protocol === requestProtocol &&
          origin.authority === host.authority
        )
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
