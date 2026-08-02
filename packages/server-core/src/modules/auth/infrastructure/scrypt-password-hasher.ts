import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'crypto'
import { AuthError } from '../domain/auth-errors.ts'
import type { PasswordHasher, TokenDigester } from '../ports/password-hasher.ts'
import { acquirePasswordSlot } from './password-limiter.ts'

const KEY_LEN = 64
const SCRYPT_N = 16_384
const SCRYPT_R = 8
const SCRYPT_P = 1
const FORMAT_PREFIX = `scrypt$v=1$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$`

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        if (error) reject(error)
        else resolve(key)
      }
    )
  })
}

async function withPasswordSlot<T>(fn: () => Promise<T>): Promise<T> {
  let release: () => void
  try {
    release = await acquirePasswordSlot()
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Password verification capacity exceeded, please retry'
    throw AuthError.rateLimited('auth.rate_limited', message)
  }

  try {
    return await fn()
  } finally {
    release()
  }
}

export class ScryptPasswordHasher implements PasswordHasher {
  readonly dummyHash = `${FORMAT_PREFIX}${Buffer.alloc(16).toString('base64url')}$${Buffer.alloc(KEY_LEN).toString('base64url')}`

  async hash(password: string): Promise<string> {
    return withPasswordSlot(async () => {
      const salt = randomBytes(16)
      const hash = await derive(password, salt)
      return `${FORMAT_PREFIX}${salt.toString('base64url')}$${hash.toString('base64url')}`
    })
  }

  async verify(password: string, stored: string): Promise<boolean> {
    return withPasswordSlot(async () => {
      if (!stored.startsWith(FORMAT_PREFIX)) return false
      const [saltRaw, expectedRaw] = stored.slice(FORMAT_PREFIX.length).split('$')
      if (!saltRaw || !expectedRaw) return false

      const actual = await derive(password, Buffer.from(saltRaw, 'base64url'))
      const expected = Buffer.from(expectedRaw, 'base64url')
      if (actual.length !== expected.length) return false
      return timingSafeEqual(actual, expected)
    })
  }
}

export class HmacTokenDigester implements TokenDigester {
  constructor(private readonly authSecret: string) {}

  digest(kind: string, value: string): string {
    return createHmac('sha256', this.authSecret).update(`${kind}:${value}`).digest('hex')
  }
}

export function hmacParts(authSecret: string, ...parts: string[]): string {
  return createHmac('sha256', authSecret).update(parts.join('')).digest('hex')
}
