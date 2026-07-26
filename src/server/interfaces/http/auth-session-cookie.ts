import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { AuthSessionResult } from '../../core/application/auth'
import type { SecureAuthModule } from '../../composition/auth'

export const AUTH_SESSION_COOKIE = 'codetask_session'
export const AUTH_CSRF_COOKIE = 'codetask_csrf'
export const AUTH_CSRF_HEADER = 'x-codetask-csrf'

function isSecureRequest(context: Context): boolean {
  return new URL(context.req.url).protocol === 'https:'
}

export function readAuthSessionCookie(context: Context): string | undefined {
  const value = getCookie(context, AUTH_SESSION_COOKIE)?.trim()
  return value || undefined
}

export function setAuthSessionCookies(
  context: Context,
  auth: SecureAuthModule,
  session: AuthSessionResult
): void {
  const maxAge = Math.max(1, Math.floor((session.expiresAtMs - Date.now()) / 1_000))
  const secure = isSecureRequest(context)
  setCookie(context, AUTH_SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: 'Strict',
    secure,
    path: '/',
    maxAge
  })
  setCookie(context, AUTH_CSRF_COOKIE, auth.csrfToken(session.token), {
    httpOnly: false,
    sameSite: 'Strict',
    secure,
    path: '/',
    maxAge
  })
  context.header('Cache-Control', 'no-store')
}

export function clearAuthSessionCookies(context: Context): void {
  const secure = isSecureRequest(context)
  deleteCookie(context, AUTH_SESSION_COOKIE, {
    secure,
    path: '/'
  })
  deleteCookie(context, AUTH_CSRF_COOKIE, {
    secure,
    path: '/'
  })
  context.header('Cache-Control', 'no-store')
}

export function hasValidCsrfToken(context: Context, auth: SecureAuthModule): boolean {
  const sessionToken = readAuthSessionCookie(context)
  const cookieToken = getCookie(context, AUTH_CSRF_COOKIE)
  const headerToken = context.req.header(AUTH_CSRF_HEADER)
  return Boolean(
    sessionToken &&
    cookieToken &&
    headerToken &&
    cookieToken === headerToken &&
    auth.verifyCsrfToken(sessionToken, headerToken)
  )
}
