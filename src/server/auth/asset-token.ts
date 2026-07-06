import { hmacAuthSecret } from '../auth/secret'

const ASSET_TOKEN_TTL_SEC = 5 * 60

export function generateAssetToken(
  authSecret: string,
  threadId: string,
  attachmentId: string
): string {
  const expiresAt = Math.floor(Date.now() / 1000) + ASSET_TOKEN_TTL_SEC
  const payload = `${threadId}:${attachmentId}:${expiresAt}`
  const mac = hmacAuthSecret(authSecret, 'asset:', payload)
  return `${expiresAt}.${mac}`
}

export function validateAssetToken(
  authSecret: string,
  token: string,
  threadId: string,
  attachmentId: string
): boolean {
  const parts = token.split('.')
  if (parts.length !== 2) return false

  const [expiresAtStr, mac] = parts
  const expiresAt = Number.parseInt(expiresAtStr, 10)
  if (!Number.isInteger(expiresAt) || expiresAt <= 0) return false

  const now = Math.floor(Date.now() / 1000)
  if (now > expiresAt) return false

  const payload = `${threadId}:${attachmentId}:${expiresAt}`
  const expected = hmacAuthSecret(authSecret, 'asset:', payload)

  return timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expected, 'hex'))
}

function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i]
  }
  return result === 0
}
