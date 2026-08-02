/** Centralized login / session policy (04 §7). */
export const LoginPolicy = {
  sessionTtlMs: 12 * 60 * 60 * 1000,
  maximumSessions: 10,
  throttleWindowMs: 15 * 60 * 1000,
  loginRequestLimit: 30,
  captchaAfterFailures: 3,
  lockAfterFailures: 8,
  lockDurationMs: 15 * 60 * 1000,
  captchaTtlMs: 5 * 60 * 1000,
  captchaMaxAttempts: 3,
  captchaRequestWindowMs: 60 * 1000,
  captchaRequestLimit: 10,
  lastSeenThrottleMs: 60_000,
  captchaCharset: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
} as const

export function normalizeUsername(username: string): string {
  return username.trim().normalize('NFKC').toLocaleLowerCase('en-US')
}
