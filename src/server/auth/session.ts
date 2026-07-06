import { AppError } from '../error'
import { TURN_ERROR_DEFAULT_MESSAGES } from '../../shared/turn-errors/codes.ts'
import { findSessionUsername } from './service'

export function bearerToken(authHeader: string | undefined): string | undefined {
  if (!authHeader?.startsWith('Bearer ')) return undefined
  const token = authHeader.slice(7).trim()
  return token || undefined
}

export async function requireUsername(authHeader: string | undefined): Promise<string> {
  const token = bearerToken(authHeader)
  if (!token) {
    throw AppError.unauthorized(TURN_ERROR_DEFAULT_MESSAGES['auth.unauthorized'])
  }
  const username = await findSessionUsername(token)
  if (!username) {
    throw AppError.unauthorized(TURN_ERROR_DEFAULT_MESSAGES['auth.session_expired'])
  }
  return username
}

export function resolveSessionTokenFromRequest(input: {
  authHeader?: string
  accessToken?: string | null
}): string | undefined {
  const headerToken = bearerToken(input.authHeader)
  if (headerToken) return headerToken
  const queryToken = input.accessToken?.trim()
  return queryToken || undefined
}

export async function requireUsernameFromRequest(input: {
  authHeader?: string
  accessToken?: string | null
}): Promise<string> {
  const token = resolveSessionTokenFromRequest(input)
  if (!token) {
    throw AppError.unauthorized(TURN_ERROR_DEFAULT_MESSAGES['auth.unauthorized'])
  }
  const username = await findSessionUsername(token)
  if (!username) {
    throw AppError.unauthorized(TURN_ERROR_DEFAULT_MESSAGES['auth.session_expired'])
  }
  return username
}
