import { randomBytes, scrypt, timingSafeEqual } from 'crypto'
import { acquirePasswordSlot } from './password-limiter'
import { AppError } from '../error'

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
    throw new AppError(42901, message, {}, 429)
  }

  try {
    return await fn()
  } finally {
    release()
  }
}

export async function hashPassword(password: string): Promise<string> {
  return withPasswordSlot(async () => {
    const salt = randomBytes(16)
    const hash = await derive(password, salt)
    return `${FORMAT_PREFIX}${salt.toString('base64url')}$${hash.toString('base64url')}`
  })
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
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

export const DUMMY_HASH = `${FORMAT_PREFIX}${Buffer.alloc(16).toString('base64url')}$${Buffer.alloc(KEY_LEN).toString('base64url')}`
