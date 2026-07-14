import type { MiddlewareHandler } from 'hono'
import { findSessionUsername } from '../auth/service'
import { resolveSessionTokenFromRequest } from '../auth/session'

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

export function isMcpApiRoute(path: string): boolean {
  const p = normalizedApiPath(path)
  return p === '/mcp' || p.startsWith('/mcp/')
}

export function isAttachmentAssetTokenGet(
  method: string,
  path: string,
  assetToken?: string | null
): boolean {
  if (method !== 'GET') return false
  if (!assetToken?.trim()) return false
  return ATTACHMENT_GET_PATH.test(normalizedApiPath(path))
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

export function requireAuth(): MiddlewareHandler {
  return async (c, next) => {
    if (isPublicApiRoute(c.req.method, c.req.path) || isMcpApiRoute(c.req.path)) {
      return next()
    }

    if (isAttachmentAssetTokenGet(c.req.method, c.req.path, c.req.query('asset_token') || c.req.header('x-asset-token'))) {
      return next()
    }

    const authHeader = c.req.header('Authorization')
    const token = resolveSessionTokenFromRequest({
      ...(authHeader !== undefined ? { authHeader } : {})
    })

    if (!token) {
      return unauthorizedResponse('Authentication required')
    }

    const username = await findSessionUsername(token)
    if (!username) {
      return unauthorizedResponse('Invalid or expired session')
    }

    return next()
  }
}
