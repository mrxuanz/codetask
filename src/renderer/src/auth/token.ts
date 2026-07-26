const LEGACY_TOKEN_KEYS = ['task_token', 'task_token_expires'] as const
const CSRF_COOKIE_NAME = 'codetask_csrf'
const CSRF_HEADER_NAME = 'x-codetask-csrf'
const SETUP_GRANT_HEADER_NAME = 'x-codetask-setup-grant'
let setupGrant = ''

function readCookie(name: string): string | null {
  const prefix = `${name}=`
  for (const part of document.cookie.split(';')) {
    const value = part.trim()
    if (!value.startsWith(prefix)) continue
    try {
      return decodeURIComponent(value.slice(prefix.length))
    } catch {
      return null
    }
  }
  return null
}

/**
 * Authentication sessions live exclusively in an HttpOnly cookie. This cleanup
 * only removes credentials left by pre-remediation releases.
 */
export function clearToken(): void {
  for (const key of LEGACY_TOKEN_KEYS) {
    localStorage.removeItem(key)
  }
}

/** Keep a first-run grant in memory only; never persist it in browser storage. */
export function setSetupGrant(value: string): void {
  setupGrant = value.trim()
}

export function clearSetupGrant(): void {
  setupGrant = ''
}

/** Headers required by the current authentication/setup phase. */
export function authHeaders(): HeadersInit {
  const headers: Record<string, string> = {}
  const csrfToken = readCookie(CSRF_COOKIE_NAME)
  if (csrfToken) headers[CSRF_HEADER_NAME] = csrfToken
  if (setupGrant) headers[SETUP_GRANT_HEADER_NAME] = setupGrant
  return headers
}

export function assetUrlWithAuth(assetUrl: string): string {
  return assetUrl
}
