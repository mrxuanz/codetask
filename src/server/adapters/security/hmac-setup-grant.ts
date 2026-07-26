import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { SetupGrantVerifier } from '../../core/application/ports'

const VERSION = 'sg1'
const MAX_TTL_MS = 15 * 60 * 1_000
const MAX_CLOCK_SKEW_MS = 30_000

export class HmacSetupGrantService implements SetupGrantVerifier {
  private readonly secret: Buffer

  constructor(secret: Uint8Array) {
    if (secret.byteLength < 32) throw new Error('auth.setup_secret.too_short')
    this.secret = Buffer.from(secret)
  }

  issue(
    nowMs: number,
    ttlMs = MAX_TTL_MS
  ): { readonly grant: string; readonly expiresAtMs: number } {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('auth.setup_time.invalid')
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) {
      throw new Error('auth.setup_ttl.invalid')
    }
    const raw = randomBytes(32).toString('base64url')
    const expiresAtMs = nowMs + ttlMs
    const payload = `${VERSION}.${raw}.${nowMs}.${expiresAtMs}`
    const mac = this.sign(payload)
    return { grant: `${payload}.${mac}`, expiresAtMs }
  }

  verify(grant: string, nowMs: number): boolean {
    if (grant.length > 512 || !Number.isSafeInteger(nowMs) || nowMs < 0) return false
    const parts = grant.split('.')
    if (parts.length !== 5) return false
    const [version, raw, issuedRaw, expiresRaw, mac] = parts
    if (
      version !== VERSION ||
      !/^[A-Za-z0-9_-]{43}$/.test(raw ?? '') ||
      !/^[a-f0-9]{64}$/.test(mac ?? '')
    ) {
      return false
    }
    const issuedAtMs = Number(issuedRaw)
    const expiresAtMs = Number(expiresRaw)
    if (
      !Number.isSafeInteger(issuedAtMs) ||
      !Number.isSafeInteger(expiresAtMs) ||
      issuedAtMs > nowMs + MAX_CLOCK_SKEW_MS ||
      expiresAtMs <= nowMs ||
      expiresAtMs <= issuedAtMs ||
      expiresAtMs - issuedAtMs > MAX_TTL_MS
    ) {
      return false
    }
    const payload = `${version}.${raw}.${issuedAtMs}.${expiresAtMs}`
    const expected = Buffer.from(this.sign(payload), 'hex')
    const actual = Buffer.from(mac ?? '', 'hex')
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('hex')
  }
}
