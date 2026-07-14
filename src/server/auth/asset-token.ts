import { hmacAuthSecret } from '../auth/secret'

/** Short-lived, owner-scoped attachment access tokens. */
const ASSET_TOKEN_TTL_SEC = 3 * 60

export function generateAssetToken(
  authSecret: string,
  owner: string,
  threadId: string,
  attachmentId: string
): string {
  const expiresAt = Math.floor(Date.now() / 1000) + ASSET_TOKEN_TTL_SEC
  const payload = `${owner}:${threadId}:${attachmentId}:${expiresAt}`
  const mac = hmacAuthSecret(authSecret, 'asset:', payload)
  return `${expiresAt}.${mac}`
}

export function validateAssetToken(
  authSecret: string,
  token: string,
  owner: string,
  threadId: string,
  attachmentId: string
): boolean {
  const parts = token.split('.')
  if (parts.length !== 2) return false

  const [expiresAtStr, mac] = parts
  if (expiresAtStr === undefined || mac === undefined) return false
  const expiresAt = Number.parseInt(expiresAtStr, 10)
  if (!Number.isInteger(expiresAt) || expiresAt <= 0) return false

  const now = Math.floor(Date.now() / 1000)
  if (now > expiresAt) return false

  const payload = `${owner}:${threadId}:${attachmentId}:${expiresAt}`
  const expected = hmacAuthSecret(authSecret, 'asset:', payload)

  return timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expected, 'hex'))
}

function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= (a[i] ?? 0) ^ (b[i] ?? 0)
  }
  return result === 0
}
