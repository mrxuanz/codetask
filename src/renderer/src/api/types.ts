export type { ApiResponse } from '@shared/contracts/api'

export interface BootstrapData {
  initialized: boolean
  authenticated: boolean
  username?: string
  setupTokenRequired?: boolean
  storagePhase?: 'selection_required' | 'ready'
  actor?: {
    userId: string
    username: string
    sessionExpiresAt: number
  }
}

export interface AuthData {
  actor?: {
    userId: string
    username: string
    sessionExpiresAt: number
  }
  /** Bearer transport only */
  token?: string
  /** @deprecated prefer actor */
  username?: string
  /** @deprecated prefer actor.sessionExpiresAt */
  expires_at?: number
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
