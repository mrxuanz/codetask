export type AuthErrorCode =
  | 'auth.credentials_required'
  | 'auth.username_invalid'
  | 'auth.password_policy_violation'
  | 'auth.setup_grant_invalid'
  | 'auth.already_initialized'
  | 'auth.setup_required'
  | 'auth.invalid_credentials'
  | 'auth.rate_limited'
  | 'auth.challenge_required'
  | 'auth.challenge_invalid'
  | 'auth.session_invalid'
  | 'auth.current_password_invalid'
  | 'auth.password_reused'
  | 'auth.concurrent_update'

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {}
  ) {
    super(code)
    this.name = 'AuthError'
  }
}
