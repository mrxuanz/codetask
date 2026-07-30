import { randomBytes, createHmac } from 'crypto'

const SETUP_TOKEN_LENGTH = 32
const SETUP_TOKEN_TTL_SEC = 15 * 60

/**
 * Process-scoped gate used when server mode starts before a data directory exists.
 * The console token is signed with this secret so the UI can collect it on the first
 * submit — before SQLite creates the durable auth_secret.
 */
let processSetupGateSecret: string | null = null

export function installProcessSetupGate(secret: string): void {
  const trimmed = secret.trim()
  if (!/^[a-f0-9]{64}$/u.test(trimmed)) {
    throw new Error('process setup gate secret must be 64 hex chars')
  }
  processSetupGateSecret = trimmed
}

export function clearProcessSetupGate(): void {
  processSetupGateSecret = null
}

export function getProcessSetupGateSecret(): string | null {
  return processSetupGateSecret
}

/** Create a fresh process gate secret (64 hex chars). */
export function createProcessSetupGateSecret(): string {
  return randomBytes(32).toString('hex')
}

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

/** Accept either the process gate (pre-storage) or the durable DB auth secret. */
export function validateSetupTokenWithGate(authSecret: string, token: string): boolean {
  if (processSetupGateSecret && validateSetupToken(processSetupGateSecret, token)) {
    return true
  }
  return validateSetupToken(authSecret, token)
}

function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i]
  }
  return result === 0
}
