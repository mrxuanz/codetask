import type { TurnErrorCode } from '../turn-errors/codes'

export const USERNAME_MIN_LENGTH = 4
export const USERNAME_MAX_LENGTH = 32
export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 128

const USERNAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]+$/
const PASSWORD_LOWERCASE_PATTERN = /[a-z]/
const PASSWORD_UPPERCASE_PATTERN = /[A-Z]/
const PASSWORD_DIGIT_PATTERN = /[0-9]/
const PASSWORD_SYMBOL_PATTERN = /[^A-Za-z0-9]/
const PASSWORD_ALLOWED_PATTERN = /^[\x20-\x7E]+$/
const COMMON_PASSWORDS = new Set([
  'admin123!@#',
  'password123!',
  'qwerty123456!',
  'welcome123!'
])

const RESERVED_USERNAMES = new Set([
  'admin',
  'administrator',
  'root',
  'guest',
  'test',
  'user',
  'default',
  'system',
  'operator',
  'superuser',
  'sa',
  'sysadmin',
  'manager',
  'postgres',
  'mysql',
  'oracle'
])

export type CredentialPolicyCode = Extract<
  TurnErrorCode,
  | 'auth.username_length_invalid'
  | 'auth.username_format_invalid'
  | 'auth.username_reserved'
  | 'auth.password_too_short'
  | 'auth.password_too_long'
  | 'auth.password_missing_lowercase'
  | 'auth.password_missing_uppercase'
  | 'auth.password_missing_digit'
  | 'auth.password_missing_symbol'
  | 'auth.password_invalid_chars'
  | 'auth.password_contains_username'
  | 'auth.password_common'
>

export interface CredentialPolicyViolation {
  code: CredentialPolicyCode
  params?: Record<string, string | number>
}

export function validateSetupUsername(username: string): CredentialPolicyViolation | null {
  const trimmed = username.trim()
  if (trimmed.length < USERNAME_MIN_LENGTH || trimmed.length > USERNAME_MAX_LENGTH) {
    return {
      code: 'auth.username_length_invalid',
      params: { minLength: USERNAME_MIN_LENGTH, maxLength: USERNAME_MAX_LENGTH }
    }
  }

  if (!USERNAME_PATTERN.test(trimmed)) {
    return { code: 'auth.username_format_invalid' }
  }

  if (RESERVED_USERNAMES.has(trimmed.toLowerCase())) {
    return { code: 'auth.username_reserved' }
  }

  return null
}

export function validateSetupPassword(
  password: string,
  username?: string
): CredentialPolicyViolation | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return {
      code: 'auth.password_too_short',
      params: { minLength: PASSWORD_MIN_LENGTH }
    }
  }

  if (password.length > PASSWORD_MAX_LENGTH) {
    return {
      code: 'auth.password_too_long',
      params: { maxLength: PASSWORD_MAX_LENGTH }
    }
  }

  if (!PASSWORD_ALLOWED_PATTERN.test(password)) {
    return { code: 'auth.password_invalid_chars' }
  }

  if (!PASSWORD_LOWERCASE_PATTERN.test(password)) {
    return { code: 'auth.password_missing_lowercase' }
  }

  if (!PASSWORD_UPPERCASE_PATTERN.test(password)) {
    return { code: 'auth.password_missing_uppercase' }
  }

  if (!PASSWORD_DIGIT_PATTERN.test(password)) {
    return { code: 'auth.password_missing_digit' }
  }

  if (!PASSWORD_SYMBOL_PATTERN.test(password)) {
    return { code: 'auth.password_missing_symbol' }
  }

  const normalizedPassword = password.toLowerCase()
  const normalizedUsername = username?.trim().toLowerCase()
  if (
    normalizedUsername &&
    normalizedUsername.length >= USERNAME_MIN_LENGTH &&
    normalizedPassword.includes(normalizedUsername)
  ) {
    return { code: 'auth.password_contains_username' }
  }

  if (COMMON_PASSWORDS.has(normalizedPassword)) {
    return { code: 'auth.password_common' }
  }

  return null
}

export function validateSetupCredentials(
  username: string,
  password: string
): CredentialPolicyViolation | null {
  return validateSetupUsername(username) ?? validateSetupPassword(password, username)
}
