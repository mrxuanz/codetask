export type { ApiResponse } from '@shared/contracts/api'

export interface BootstrapData {
  initialized: boolean
  authenticated: boolean
  username?: string
  setupTokenRequired?: boolean
  storagePhase?: 'selection_required' | 'ready' | 'recovery_required'
  storageDefaultCandidate?: string
  storageIssue?: string
}

export interface AuthData {
  username: string
  expires_at: number
}

export interface CaptchaChallenge {
  challengeId: string
  image: string
  expires_at: number
}

export interface LoginErrorData {
  captchaRequired?: boolean
  retryAfterMs?: number
}

export interface LoginPayload {
  username: string
  password: string
  captchaId?: string
  captchaAnswer?: string
  setupToken?: string
}
