const LEGACY_TOKEN_KEY = 'task_token'
const LEGACY_EXPIRES_KEY = 'task_token_expires'
const CSRF_COOKIE = 'codetask_csrf'
const CSRF_HEADER = 'x-codetask-csrf'

function readCookie(name: string): string | null {
  const prefix = `${encodeURIComponent(name)}=`
  for (const part of document.cookie.split(';')) {
    const value = part.trim()
    if (value.startsWith(prefix)) {
      return decodeURIComponent(value.slice(prefix.length))
    }
  }
  return null
}

/** Remove only deprecated renderer credentials; the session itself is HttpOnly. */
export function clearToken(): void {
  localStorage.removeItem(LEGACY_TOKEN_KEY)
  localStorage.removeItem(LEGACY_EXPIRES_KEY)
  document.cookie = `${CSRF_COOKIE}=; Max-Age=0; Path=/; SameSite=Strict`
}

export function authHeaders(): HeadersInit {
  const csrf = readCookie(CSRF_COOKIE)
  return csrf ? { [CSRF_HEADER]: csrf } : {}
}

export function assetUrlWithAuth(assetUrl: string): string {
  return assetUrl
}
