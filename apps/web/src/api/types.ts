import type {
  ApiResponse as ContractApiResponse,
  ApiSuccess,
  ApiFailure
} from '@codetask/contracts'

/** Production client envelope — ApiSuccess | ApiFailure only. */
export type ApiResponse<T> = ContractApiResponse<T>
export type { ApiSuccess, ApiFailure }

/** @deprecated Prefer ApiResponse — legacy hybrid envelope removed in R4. */
export type { ClientApiResponse } from '@codetask/contracts'

export type AuthData = {
  userId: string
  username: string
  token?: string
}

export type BootstrapData = {
  initialized: boolean
  authenticated: boolean
  setupTokenRequired?: boolean
  storagePhase?: 'ready' | 'selection_required' | string
  user?: { id: string; username: string } | null
}

export type CaptchaChallenge = {
  challengeId: string
  image: string
}

export type LoginPayload = {
  username: string
  password: string
  captchaId?: string
  captchaAnswer?: string
}
