import type { MiddlewareHandler } from 'hono'
import type { SecurityContext } from '../context/types'
import {
  clearSessionCookies,
  readSessionCredential,
  requestHasValidCsrf,
  runWithAuthPrincipal
} from '@codetask/server-core/modules/auth'

interface AllowlistEntry {
  method: string
  path: string
}

/** Public routes only (04 §10) — whitelist, not blacklist. */
const PUBLIC_ALLOWLIST: AllowlistEntry[] = [
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/auth/bootstrap' },
  { method: 'POST', path: '/auth/setup' },
  { method: 'POST', path: '/auth/login' },
  { method: 'POST', path: '/auth/captcha' }
]

export const ATTACHMENT_GET_PATH =
  /^\/(?:conversations|threads)\/[^/]+\/attachments\/[^/]+$/
const API_PREFIX = '/api'
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function normalizedApiPath(path: string): string {
  const withoutQuery = path.split('?')[0] ?? path
  if (withoutQuery === API_PREFIX) return '/'
  if (withoutQuery.startsWith(`${API_PREFIX}/`)) {
    return withoutQuery.slice(API_PREFIX.length) || '/'
  }
  return withoutQuery
}

export function isPublicApiRoute(method: string, path: string): boolean {
  const normalized = normalizedApiPath(path)
  return PUBLIC_ALLOWLIST.some((entry) => entry.method === method && entry.path === normalized)
}

export function isAttachmentAssetTokenGet(
  method: string,
  path: string,
  assetToken?: string | null
): boolean {
  return (
    method === 'GET' &&
    Boolean(assetToken?.trim()) &&
    ATTACHMENT_GET_PATH.test(normalizedApiPath(path))
  )
}

function authError(message: string, status = 401, errorCode = 'auth.unauthorized'): Response {
  return new Response(
    JSON.stringify({
      data: {
        error: message,
        code: errorCode,
        turnErrorCode: errorCode
      },
      status: status === 403 ? 40301 : 40101,
      extra: {},
      message: errorCode,
      success: false
    }),
    {
      status,
      headers: { 'Content-Type': 'application/json' }
    }
  )
}

/**
 * Session Auth middleware. MCP is mounted on a sibling router without this middleware
 * (own protocol boundary — 04 §10).
 */
export function requireAuth(security?: SecurityContext): MiddlewareHandler {
  return async (c, next) => {
    if (isPublicApiRoute(c.req.method, c.req.path)) {
      return next()
    }
    // Asset-token GETs skip session auth; attachment route validates the resource token.
    if (
      isAttachmentAssetTokenGet(
        c.req.method,
        c.req.path,
        c.req.query('asset_token') || c.req.header('x-asset-token')
      )
    ) {
      return next()
    }

    const credential = readSessionCredential(c)
    if (!credential.token) return authError('Authentication required', 401, 'auth.unauthorized')
    if (!security) return authError('Invalid or expired session', 401, 'auth.session_expired')
    const principal = security.auth.authenticateToken(credential.token)
    if (!principal) {
      if (credential.transport === 'cookie') clearSessionCookies(c)
      return authError('Invalid or expired session', 401, 'auth.session_expired')
    }
    if (
      credential.transport === 'cookie' &&
      !SAFE_METHODS.has(c.req.method) &&
      !requestHasValidCsrf(c, security.authSecret)
    ) {
      return authError('Invalid CSRF token', 403, 'auth.csrf_invalid')
    }

    return runWithAuthPrincipal(principal, next)
  }
}
