const TOKEN_KEY = 'task_token'
const EXPIRES_KEY = 'task_token_expires'
const DEFAULT_TTL_SEC = 12 * 60 * 60

export function setToken(token: string, expiresAtSec?: number): void {
  const expires = expiresAtSec ?? Math.floor(Date.now() / 1000) + DEFAULT_TTL_SEC
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(EXPIRES_KEY, String(expires))
}

export function getToken(): string | null {
  const token = localStorage.getItem(TOKEN_KEY)
  const expiresRaw = localStorage.getItem(EXPIRES_KEY)
  if (!token || !expiresRaw) return null

  const expiresAt = Number(expiresRaw)
  if (Number.isNaN(expiresAt) || Math.floor(Date.now() / 1000) >= expiresAt) {
    clearToken()
    return null
  }
  return token
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(EXPIRES_KEY)
}

export function authHeaders(): HeadersInit {
  const token = getToken()
  if (!token) return {}
  return { Authorization: `Bearer ${token}` }
}

export function assetUrlWithAuth(assetUrl: string): string {
  return assetUrl
}
