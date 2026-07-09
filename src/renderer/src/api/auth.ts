import { api } from './client'
import type { ApiResponse } from './types'
import type { AuthData, BootstrapData, CaptchaChallenge, LoginPayload } from './types'
import { clearToken } from '@renderer/auth/token'

export function fetchBootstrap(): Promise<ApiResponse<BootstrapData>> {
  return api<BootstrapData>('/api/bootstrap')
}

export function setup(
  username: string,
  password: string,
  setupToken?: string
): Promise<ApiResponse<AuthData>> {
  return api<AuthData>('/api/setup', {
    method: 'POST',
    body: JSON.stringify({ username, password, setupToken })
  })
}

export function login(payload: LoginPayload): Promise<ApiResponse<AuthData>> {
  return api<AuthData>('/api/login', {
    method: 'POST',
    body: JSON.stringify(payload)
  })
}

export function fetchCaptcha(): Promise<ApiResponse<CaptchaChallenge>> {
  return api<CaptchaChallenge>('/api/captcha', {
    method: 'POST'
  })
}

export async function logout(): Promise<ApiResponse<{ loggedOut: boolean }>> {
  try {
    return await api<{ loggedOut: boolean }>('/api/logout', { method: 'POST' })
  } finally {
    clearToken()
  }
}
