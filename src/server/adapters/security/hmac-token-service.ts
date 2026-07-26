import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { SecureTokenService } from '../../core/application/ports'

export class HmacTokenService implements SecureTokenService {
  private readonly secret: Buffer

  constructor(secret: Uint8Array) {
    if (secret.byteLength < 32) throw new Error('auth.token_secret.too_short')
    this.secret = Buffer.from(secret)
  }

  generateToken(byteLength = 32): string {
    if (!Number.isSafeInteger(byteLength) || byteLength < 24 || byteLength > 128) {
      throw new Error('auth.token_length.invalid')
    }
    return randomBytes(byteLength).toString('base64url')
  }

  digest(context: string, value: string): string {
    if (!context || context.length > 128) throw new Error('auth.token_context.invalid')
    return createHmac('sha256', this.secret)
      .update(`${context.length}:`)
      .update(context)
      .update(`${value.length}:`)
      .update(value)
      .digest('hex')
  }

  equalsDigest(left: string, right: string): boolean {
    if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false
    return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
  }
}
