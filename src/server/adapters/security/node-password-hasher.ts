import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import {
  AuthSecurityCapacityError,
  type PasswordHasher,
  type PasswordVerification
} from '../../core/application/ports'

const FORMAT = 'scrypt'
const VERSION = 1

export interface NodePasswordHasherOptions {
  readonly cost?: number
  readonly blockSize?: number
  readonly parallelization?: number
  readonly keyLength?: number
  readonly saltBytes?: number
  readonly maxConcurrent?: number
  readonly maxQueued?: number
}

interface RequiredOptions {
  readonly cost: number
  readonly blockSize: number
  readonly parallelization: number
  readonly keyLength: number
  readonly saltBytes: number
  readonly maxConcurrent: number
  readonly maxQueued: number
}

interface ParsedPasswordHash {
  readonly cost: number
  readonly blockSize: number
  readonly parallelization: number
  readonly salt: Buffer
  readonly expected: Buffer
}

class InstanceWorkLimiter {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number
  ) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      if (this.waiters.length >= this.maxQueued) throw new AuthSecurityCapacityError()
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    this.active += 1
    try {
      return await work()
    } finally {
      this.active -= 1
      this.waiters.shift()?.()
    }
  }
}

function resolveOptions(options: NodePasswordHasherOptions): RequiredOptions {
  const resolved: RequiredOptions = {
    cost: options.cost ?? 32_768,
    blockSize: options.blockSize ?? 8,
    parallelization: options.parallelization ?? 1,
    keyLength: options.keyLength ?? 64,
    saltBytes: options.saltBytes ?? 16,
    maxConcurrent: options.maxConcurrent ?? 2,
    maxQueued: options.maxQueued ?? 32
  }
  if (
    !Number.isSafeInteger(resolved.cost) ||
    resolved.cost < 16_384 ||
    (resolved.cost & (resolved.cost - 1)) !== 0 ||
    !Number.isSafeInteger(resolved.blockSize) ||
    resolved.blockSize < 8 ||
    resolved.blockSize > 32 ||
    !Number.isSafeInteger(resolved.parallelization) ||
    resolved.parallelization < 1 ||
    resolved.parallelization > 4 ||
    !Number.isSafeInteger(resolved.keyLength) ||
    resolved.keyLength < 32 ||
    resolved.keyLength > 128 ||
    !Number.isSafeInteger(resolved.saltBytes) ||
    resolved.saltBytes < 16 ||
    resolved.saltBytes > 64 ||
    !Number.isSafeInteger(resolved.maxConcurrent) ||
    resolved.maxConcurrent < 1 ||
    !Number.isSafeInteger(resolved.maxQueued) ||
    resolved.maxQueued < 0
  ) {
    throw new Error('auth.password_hasher.options_invalid')
  }
  return resolved
}

function parsePasswordHash(encoded: string): ParsedPasswordHash | null {
  const legacy = /^(?:v1:)?([a-f0-9]{32}):([a-f0-9]{128})$/i.exec(encoded)
  if (legacy) {
    return {
      cost: 16_384,
      blockSize: 8,
      parallelization: 1,
      // Legacy releases passed the printable hex text to scrypt, not the
      // decoded 16-byte salt. Preserve those exact bytes for one-time rehash.
      salt: Buffer.from(legacy[1] ?? '', 'utf8'),
      expected: Buffer.from(legacy[2] ?? '', 'hex')
    }
  }

  const parts = encoded.split('$')
  if (parts.length !== 8 || parts[0] !== FORMAT || parts[1] !== `v=${VERSION}`) return null
  const cost = Number(parts[2]?.replace('N=', ''))
  const blockSize = Number(parts[3]?.replace('r=', ''))
  const parallelization = Number(parts[4]?.replace('p=', ''))
  const saltHex = parts[5] ?? ''
  const hashHex = parts[6] ?? ''
  const marker = parts[7]
  if (
    marker !== 'end' ||
    !Number.isSafeInteger(cost) ||
    cost < 16_384 ||
    cost > 1_048_576 ||
    (cost & (cost - 1)) !== 0 ||
    !Number.isSafeInteger(blockSize) ||
    blockSize < 8 ||
    blockSize > 32 ||
    !Number.isSafeInteger(parallelization) ||
    parallelization < 1 ||
    parallelization > 4 ||
    !/^[a-f0-9]{32,128}$/i.test(saltHex) ||
    !/^[a-f0-9]{64,256}$/i.test(hashHex)
  ) {
    return null
  }
  return {
    cost,
    blockSize,
    parallelization,
    salt: Buffer.from(saltHex, 'hex'),
    expected: Buffer.from(hashHex, 'hex')
  }
}

export class NodePasswordHasher implements PasswordHasher {
  private readonly options: RequiredOptions
  private readonly limiter: InstanceWorkLimiter
  private readonly dummyHash: string

  constructor(options: NodePasswordHasherOptions = {}) {
    this.options = resolveOptions(options)
    this.limiter = new InstanceWorkLimiter(this.options.maxConcurrent, this.options.maxQueued)
    this.dummyHash = `${FORMAT}$v=${VERSION}$N=${this.options.cost}$r=${this.options.blockSize}$p=${this.options.parallelization}$${'0'.repeat(this.options.saltBytes * 2)}$${'0'.repeat(this.options.keyLength * 2)}$end`
  }

  async hash(password: string): Promise<string> {
    return this.limiter.run(async () => {
      const salt = randomBytes(this.options.saltBytes)
      const derived = await this.derive(password, salt, this.options)
      return `${FORMAT}$v=${VERSION}$N=${this.options.cost}$r=${this.options.blockSize}$p=${this.options.parallelization}$${salt.toString('hex')}$${derived.toString('hex')}$end`
    })
  }

  async verify(password: string, encodedHash: string | null): Promise<PasswordVerification> {
    return this.limiter.run(async () => {
      const parsed = parsePasswordHash(encodedHash ?? this.dummyHash)
      const selected = parsed ?? parsePasswordHash(this.dummyHash)
      if (!selected) throw new Error('auth.password_hasher.dummy_hash_invalid')
      const actual = await this.derive(password, selected.salt, {
        ...this.options,
        cost: selected.cost,
        blockSize: selected.blockSize,
        parallelization: selected.parallelization,
        keyLength: selected.expected.length
      })
      const valid =
        encodedHash !== null &&
        parsed !== null &&
        actual.length === selected.expected.length &&
        timingSafeEqual(actual, selected.expected)
      return {
        valid,
        needsRehash:
          valid &&
          (selected.cost !== this.options.cost ||
            selected.blockSize !== this.options.blockSize ||
            selected.parallelization !== this.options.parallelization ||
            selected.expected.length !== this.options.keyLength ||
            selected.salt.length !== this.options.saltBytes)
      }
    })
  }

  private async derive(
    password: string,
    salt: Buffer,
    options: Pick<RequiredOptions, 'cost' | 'blockSize' | 'parallelization' | 'keyLength'>
  ): Promise<Buffer> {
    const maxmem = Math.max(
      64 * 1024 * 1024,
      128 * options.cost * options.blockSize + 8 * 1024 * 1024
    )
    return new Promise<Buffer>((resolve, reject) => {
      scrypt(
        password,
        salt,
        options.keyLength,
        {
          N: options.cost,
          r: options.blockSize,
          p: options.parallelization,
          maxmem
        },
        (error, derivedKey) => {
          if (error) {
            reject(error)
            return
          }
          resolve(derivedKey)
        }
      )
    })
  }
}
