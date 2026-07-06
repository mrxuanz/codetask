import { randomBytes, scrypt, timingSafeEqual } from 'crypto'
import { promisify } from 'util'
import { acquirePasswordSlot } from './password-limiter'
import { AppError } from '../error'

const scryptAsync = promisify(scrypt)
const KEY_LEN = 64
const V1_PREFIX = 'v1:'

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
    const salt = randomBytes(16).toString('hex')
    const hash = (await scryptAsync(password, salt, KEY_LEN)) as Buffer
    return `${V1_PREFIX}${salt}:${hash.toString('hex')}`
  })
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  return withPasswordSlot(async () => {
    const raw = stored.startsWith(V1_PREFIX) ? stored.slice(V1_PREFIX.length) : stored
    const [salt, expected] = raw.split(':')
    if (!salt || !expected) return false

    const actual = (await scryptAsync(password, salt, KEY_LEN)) as Buffer
    const a = Buffer.from(actual)
    const b = Buffer.from(expected, 'hex')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  })
}

export const DUMMY_HASH =
  'v1:00000000000000000000000000000000:00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'
