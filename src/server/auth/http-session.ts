import { randomBytes, timingSafeEqual } from 'crypto'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { hmacAuthSecret } from './secret'

export const SESSION_COOKIE = 'codetask_session'
export const CSRF_COOKIE = 'codetask_csrf'
export const CSRF_HEADER = 'x-codetask-csrf'

export interface SessionCredential {
  token?: string
  transport: 'cookie' | 'bearer' | 'none'
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header?.startsWith('Bearer ')) return undefined
  return header.slice(7).trim() || undefined
}

function cookieIsSecure(c: Context): boolean {
  return new URL(c.req.url).protocol === 'https:'
}

export function readSessionCredential(c: Context): SessionCredential {
  const bearer = bearerToken(c.req.header('Authorization'))
  if (bearer) return { token: bearer, transport: 'bearer' }
  const cookie = getCookie(c, SESSION_COOKIE)?.trim()
  if (cookie) return { token: cookie, transport: 'cookie' }
  return { transport: 'none' }
}

export function createCsrfToken(authSecret: string): string {
  const nonce = randomBytes(24).toString('base64url')
  const signature = hmacAuthSecret(authSecret, 'csrf:', nonce)
  return `${nonce}.${signature}`
}

export function verifyCsrfToken(authSecret: string, token: string | undefined): boolean {
  if (!token) return false
  const separator = token.lastIndexOf('.')
  if (separator <= 0) return false
  const nonce = token.slice(0, separator)
  const actual = token.slice(separator + 1)
  const expected = hmacAuthSecret(authSecret, 'csrf:', nonce)
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function requestHasValidCsrf(c: Context, authSecret: string): boolean {
  const cookie = getCookie(c, CSRF_COOKIE)
  const header = c.req.header(CSRF_HEADER)
  if (!cookie || !header || cookie !== header) return false
  return verifyCsrfToken(authSecret, cookie)
}

export function issueSessionCookies(
  c: Context,
  input: { token: string; expiresAtSec: number; authSecret: string }
): void {
  const common = {
    path: '/',
    sameSite: 'Strict' as const,
    secure: cookieIsSecure(c),
    expires: new Date(input.expiresAtSec * 1000)
  }
  setCookie(c, SESSION_COOKIE, input.token, {
    ...common,
    httpOnly: true
  })
  setCookie(c, CSRF_COOKIE, createCsrfToken(input.authSecret), {
    ...common,
    httpOnly: false
  })
}

export function clearSessionCookies(c: Context): void {
  const options = {
    path: '/',
    sameSite: 'Strict' as const,
    secure: cookieIsSecure(c)
  }
  deleteCookie(c, SESSION_COOKIE, options)
  deleteCookie(c, CSRF_COOKIE, options)
}
