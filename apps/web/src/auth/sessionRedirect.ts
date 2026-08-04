import { clearToken } from './token'

const UNAUTHORIZED_STATUS = 40101

let redirecting = false

export function isUnauthorizedApiError(status: number, message: string): boolean {
  if (status === UNAUTHORIZED_STATUS || status === 401) return true
  const normalized = message.trim().toLowerCase()
  return (
    normalized === 'not signed in' ||
    normalized === 'session expired' ||
    message === '未登录' ||
    message === '会话已过期'
  )
}

function isLoginGuardError(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const record = data as Record<string, unknown>
  return (
    record.captchaRequired === true ||
    typeof record.lockedUntil === 'number' ||
    typeof record.retryAfterSec === 'number'
  )
}

export function shouldClearSessionOnApiError(
  httpStatus: number,
  apiStatus: number,
  message: string,
  data: unknown
): boolean {
  if (httpStatus === 429) return false
  if (!isUnauthorizedApiError(apiStatus, message)) return false
  if (isLoginGuardError(data)) return false
  return true
}

export function handleUnauthorizedApiError(): void {
  clearToken()

  const path = window.location.pathname
  if (redirecting || path === '/login' || path === '/setup') return

  redirecting = true
  window.location.replace('/login')
}
