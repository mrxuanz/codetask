import { api } from './client'
import type { ApiResponse } from './types'
import { clearToken } from '@renderer/auth/token'

export async function logout(): Promise<ApiResponse<{ loggedOut: boolean }>> {
  try {
    return await api<{ loggedOut: boolean }>('/api/logout', { method: 'POST' })
  } finally {
    clearToken()
  }
}
