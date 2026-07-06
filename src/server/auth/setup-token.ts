import { randomBytes, createHmac } from 'crypto'

const SETUP_TOKEN_LENGTH = 32
const SETUP_TOKEN_TTL_SEC = 15 * 60

export function generateSetupToken(authSecret: string): { token: string; expiresAt: number } {
  const raw = randomBytes(SETUP_TOKEN_LENGTH).toString('hex')
  const timestamp = Math.floor(Date.now() / 1000)
  const payload = `${raw}:${timestamp}`
  const mac = createHmac('sha256', authSecret).update(payload).digest('hex')
  const token = `${raw}.${timestamp}.${mac}`

  return {
    token,
    expiresAt: Math.floor(Date.now() / 1000) + SETUP_TOKEN_TTL_SEC
  }
}

export function validateSetupToken(authSecret: string, token: string): boolean {
  const parts = token.split('.')
  if (parts.length !== 3) return false

  const [raw, tsStr, mac] = parts
  const timestamp = Number.parseInt(tsStr, 10)
  if (!Number.isInteger(timestamp) || timestamp <= 0) return false

  const now = Math.floor(Date.now() / 1000)
  if (now - timestamp > SETUP_TOKEN_TTL_SEC) return false

  const payload = `${raw}:${timestamp}`
  const expected = createHmac('sha256', authSecret).update(payload).digest('hex')

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
