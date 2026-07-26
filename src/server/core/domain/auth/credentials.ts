export const AUTH_USERNAME_MIN_LENGTH = 4
export const AUTH_USERNAME_MAX_LENGTH = 32
export const AUTH_PASSWORD_MIN_LENGTH = 12
export const AUTH_PASSWORD_MAX_LENGTH = 128

const USERNAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]+$/
const PASSWORD_PRINTABLE_ASCII = /^[\x20-\x7e]+$/
const RESERVED_USERNAMES = new Set([
  'admin',
  'administrator',
  'default',
  'guest',
  'operator',
  'root',
  'system',
  'test',
  'user'
])
const COMMON_PASSWORDS = new Set(['admin123!@#', 'password123!', 'qwerty123456!', 'welcome123!'])

export type AuthCredentialViolation =
  | 'username_length'
  | 'username_format'
  | 'username_reserved'
  | 'password_length'
  | 'password_characters'
  | 'password_complexity'
  | 'password_contains_username'
  | 'password_common'

export function normalizeAuthUsername(username: string): string {
  return username.trim().toLowerCase()
}

export function validateAuthUsername(username: string): AuthCredentialViolation | null {
  const normalized = normalizeAuthUsername(username)
  if (
    normalized.length < AUTH_USERNAME_MIN_LENGTH ||
    normalized.length > AUTH_USERNAME_MAX_LENGTH
  ) {
    return 'username_length'
  }
  if (!USERNAME_PATTERN.test(username.trim())) return 'username_format'
  if (RESERVED_USERNAMES.has(normalized)) return 'username_reserved'
  return null
}

export function validateAuthPassword(
  username: string,
  password: string
): AuthCredentialViolation | null {
  if (password.length < AUTH_PASSWORD_MIN_LENGTH || password.length > AUTH_PASSWORD_MAX_LENGTH) {
    return 'password_length'
  }
  if (!PASSWORD_PRINTABLE_ASCII.test(password)) return 'password_characters'
  if (
    !/[a-z]/.test(password) ||
    !/[A-Z]/.test(password) ||
    !/[0-9]/.test(password) ||
    !/[^A-Za-z0-9]/.test(password)
  ) {
    return 'password_complexity'
  }
  const normalizedPassword = password.toLowerCase()
  const normalizedUsername = normalizeAuthUsername(username)
  if (normalizedUsername.length >= 4 && normalizedPassword.includes(normalizedUsername)) {
    return 'password_contains_username'
  }
  if (COMMON_PASSWORDS.has(normalizedPassword)) return 'password_common'
  return null
}
