import type { MiddlewareHandler } from 'hono'
import type { SecureAuthModule } from '../composition/auth'
import { setRequestAuthPrincipal } from '../auth/session'
import {
  clearAuthSessionCookies,
  hasValidCsrfToken,
  readAuthSessionCookie
} from '../interfaces/http/auth-session-cookie'

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

const API_PREFIX = '/api'

export function normalizedApiPath(path: string): string {
  const withoutQuery = path.split('?')[0] ?? path
  if (withoutQuery === API_PREFIX) return '/'
  if (withoutQuery.startsWith(`${API_PREFIX}/`)) {
    return withoutQuery.slice(API_PREFIX.length) || '/'
  }
  return withoutQuery
}

export function isPublicApiRoute(method: string, path: string): boolean {
  const p = normalizedApiPath(path)
  return PUBLIC_ALLOWLIST.some((entry) => entry.method === method && entry.path === p)
}

function unauthorizedResponse(message: string): Response {
  return new Response(
    JSON.stringify({
      data: null,
      status: 40101,
      extra: {},
      message,
      success: false
    }),
    {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    }
  )
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function requireAuth(auth: SecureAuthModule): MiddlewareHandler {
  return async (c, next) => {
    if (isPublicApiRoute(c.req.method, c.req.path)) {
      return next()
    }

    const token = readAuthSessionCookie(c)
    if (!token) {
      return unauthorizedResponse('Authentication required')
    }

    const principal = auth.service.tryAuthenticate(token)
    if (!principal) {
      clearAuthSessionCookies(c)
      return unauthorizedResponse('Invalid or expired session')
    }

    if (WRITE_METHODS.has(c.req.method) && !hasValidCsrfToken(c, auth)) {
      return new Response(
        JSON.stringify({
          data: null,
          status: 40301,
          extra: {},
          message: 'auth.csrf_invalid',
          success: false
        }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        }
      )
    }

    setRequestAuthPrincipal(c, principal)
    return next()
  }
}
