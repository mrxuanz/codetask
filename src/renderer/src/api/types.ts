export type { ApiResponse } from '@shared/contracts/api'

export interface BootstrapData {
  initialized: boolean
  authenticated: boolean
  username?: string
  setupTokenRequired?: boolean
}

export interface AuthData {
  token: string
  username: string
  expires_at: number
}

export interface CaptchaChallenge {
  challengeId: string
  image: string
}

export interface LoginErrorData {
  captchaRequired?: boolean
  lockedUntil?: number
  retryAfterSec?: number
}

export interface LoginPayload {
  username: string
  password: string
  captchaId?: string
  captchaAnswer?: string
  setupToken?: string
}
