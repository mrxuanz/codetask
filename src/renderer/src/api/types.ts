export type { ApiResponse } from '@shared/contracts/api'

export interface BootstrapData {
  initialized: boolean
  authenticated: boolean
  username?: string
  setupTokenRequired?: boolean
  storagePhase?: 'selection_required' | 'ready' | 'recovery_required'
  controlPlaneGeneration?: 'preparing' | 'copied' | 'v3_authoritative' | null
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
