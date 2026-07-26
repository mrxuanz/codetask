import { api } from './client'
import type { ApiResponse } from './types'
import type { AuthData, BootstrapData, CaptchaChallenge, LoginPayload } from './types'
import { clearSetupGrant, clearToken } from '@renderer/auth/token'

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
  }).then((response) => {
    clearSetupGrant()
    return response
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

export async function logoutAll(): Promise<ApiResponse<{ loggedOut: boolean }>> {
  try {
    return await api<{ loggedOut: boolean }>('/api/logout-all', { method: 'POST' })
  } finally {
    clearToken()
  }
}

export function changePassword(
  currentPassword: string,
  newPassword: string
): Promise<ApiResponse<AuthData>> {
  return api<AuthData>('/api/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword })
  })
}
