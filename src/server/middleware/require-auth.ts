import type { MiddlewareHandler } from 'hono'
import type { SecurityContext } from '../context/types'
import {
  clearSessionCookies,
  readSessionCredential,
  requestHasValidCsrf
} from '../auth/http-session'
import { runWithAuthPrincipal } from '../auth/session'

interface AllowlistEntry {
  method: string
  path: string
}

const PUBLIC_ALLOWLIST: AllowlistEntry[] = [
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/bootstrap' },
  { method: 'POST', path: '/login' },
  { method: 'POST', path: '/setup' },
  { method: 'POST', path: '/captcha' }
]

export const ATTACHMENT_GET_PATH = /^\/threads\/[^/]+\/attachments\/[^/]+$/
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

export function isMcpApiRoute(path: string): boolean {
  const normalized = normalizedApiPath(path)
  return normalized === '/mcp' || normalized.startsWith('/mcp/')
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

function authError(message: string, status = 401): Response {
  return new Response(
    JSON.stringify({
      data: null,
      status: status === 403 ? 40301 : 40101,
      extra: {},
      message,
      success: false
    }),
    {
      status,
      headers: { 'Content-Type': 'application/json' }
    }
  )
}

export function requireAuth(security?: SecurityContext): MiddlewareHandler {
  return async (c, next) => {
    if (isPublicApiRoute(c.req.method, c.req.path) || isMcpApiRoute(c.req.path)) {
      return next()
    }
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
    if (!credential.token) return authError('Authentication required')
    if (!security) return authError('Invalid or expired session')
    const principal = security.auth.authenticateToken(credential.token)
    if (!principal) {
      if (credential.transport === 'cookie') clearSessionCookies(c)
      return authError('Invalid or expired session')
    }
    if (
      credential.transport === 'cookie' &&
      !SAFE_METHODS.has(c.req.method) &&
      !requestHasValidCsrf(c, security.authSecret)
    ) {
      return authError('Invalid CSRF token', 403)
    }

    return runWithAuthPrincipal(principal, next)
  }
}
