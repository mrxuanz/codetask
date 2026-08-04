import { api } from './client'
import type { ApiSuccess, AuthData, BootstrapData, CaptchaChallenge, LoginPayload } from './types'
import { clearToken } from '@renderer/auth/token'

export function fetchBootstrap(): Promise<ApiSuccess<BootstrapData>> {
  return api<BootstrapData>('/api/auth/bootstrap')
}

export function setup(
  username: string,
  password: string,
  setupToken?: string
): Promise<ApiSuccess<AuthData>> {
  return api<AuthData>('/api/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ username, password, setupToken })
  })
}

export function login(payload: LoginPayload): Promise<ApiSuccess<AuthData>> {
  return api<AuthData>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(payload)
  })
}

export function fetchCaptcha(): Promise<ApiSuccess<CaptchaChallenge>> {
  return api<CaptchaChallenge>('/api/auth/captcha', {
    method: 'POST'
  })
}

export async function logout(): Promise<ApiSuccess<{ loggedOut: boolean }>> {
  try {
    return await api<{ loggedOut: boolean }>('/api/auth/logout', { method: 'POST' })
  } finally {
    clearToken()
  }
}
