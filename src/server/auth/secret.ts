import { createHmac, randomBytes } from 'crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'

const SECRET_LENGTH = 32

export interface AppSecretProvider {
  loadOrCreateAuthSecret(): Promise<Uint8Array>
  rotateAuthSecret(): Promise<void>
  describeStorage(): { kind: 'os_store' | 'credential_file' | 'fallback_file' }
}

export interface AppSecretCipher {
  encrypt(plaintext: string): Uint8Array
  decrypt(ciphertext: Uint8Array): string
}

function generateSecretBytes(): Uint8Array {
  return randomBytes(SECRET_LENGTH)
}

function parseSecret(raw: string): Uint8Array | null {
  const hex = raw.trim()
  if (!/^[a-f0-9]{64}$/i.test(hex)) return null
  return Buffer.from(hex, 'hex')
}

function writeSecret(path: string, secret: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, Buffer.from(secret).toString('hex'), { encoding: 'utf8', mode: 0o600 })
  if (process.platform !== 'win32') chmodSync(tmp, 0o600)
  renameSync(tmp, path)
  if (process.platform !== 'win32') chmodSync(path, 0o600)
}

function readExistingSecret(path: string): Uint8Array | null {
  if (!existsSync(path)) return null
  const secret = parseSecret(readFileSync(path, 'utf8'))
  if (!secret) throw new Error(`Auth secret is corrupt: ${path}`)
  if (process.platform !== 'win32') chmodSync(path, 0o600)
  return secret
}

export class FileAppSecretProvider implements AppSecretProvider {
  constructor(
    private readonly secretPath: string,
    private readonly kind: 'credential_file' | 'fallback_file' = 'fallback_file'
  ) {}

  async loadOrCreateAuthSecret(): Promise<Uint8Array> {
    return this.loadOrCreateAuthSecretSync()
  }

  loadOrCreateAuthSecretSync(): Uint8Array {
    const existing = readExistingSecret(this.secretPath)
    if (existing) return existing

    const secret = generateSecretBytes()
    writeSecret(this.secretPath, secret)
    return secret
  }

  async rotateAuthSecret(): Promise<void> {
    writeSecret(this.secretPath, generateSecretBytes())
  }

  describeStorage(): { kind: 'credential_file' | 'fallback_file' } {
    return { kind: this.kind }
  }
}

interface EncryptedSecretEnvelope {
  formatVersion: 1
  ciphertext: string
}

function parseEncryptedEnvelope(raw: string): EncryptedSecretEnvelope | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (
      value.formatVersion !== 1 ||
      typeof value.ciphertext !== 'string' ||
      !value.ciphertext.trim()
    ) {
      return null
    }
    return { formatVersion: 1, ciphertext: value.ciphertext }
  } catch {
    return null
  }
}

export class EncryptedFileAppSecretProvider implements AppSecretProvider {
  constructor(
    private readonly secretPath: string,
    private readonly cipher: AppSecretCipher
  ) {}

  async loadOrCreateAuthSecret(): Promise<Uint8Array> {
    if (existsSync(this.secretPath)) {
      const raw = readFileSync(this.secretPath, 'utf8')
      const envelope = parseEncryptedEnvelope(raw)
      if (envelope) {
        const decrypted = this.cipher.decrypt(Buffer.from(envelope.ciphertext, 'base64'))
        const secret = parseSecret(decrypted)
        if (!secret) throw new Error(`Encrypted auth secret is corrupt: ${this.secretPath}`)
        return secret
      }
      throw new Error(`Encrypted auth secret is corrupt: ${this.secretPath}`)
    }

    const secret = generateSecretBytes()
    this.writeEncrypted(secret)
    return secret
  }

  async rotateAuthSecret(): Promise<void> {
    this.writeEncrypted(generateSecretBytes())
  }

  describeStorage(): { kind: 'os_store' } {
    return { kind: 'os_store' }
  }

  private writeEncrypted(secret: Uint8Array): void {
    const ciphertext = this.cipher.encrypt(Buffer.from(secret).toString('hex'))
    const envelope: EncryptedSecretEnvelope = {
      formatVersion: 1,
      ciphertext: Buffer.from(ciphertext).toString('base64')
    }
    mkdirSync(dirname(this.secretPath), { recursive: true })
    const tmp = `${this.secretPath}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, `${JSON.stringify(envelope)}\n`, { encoding: 'utf8', mode: 0o600 })
    if (process.platform !== 'win32') chmodSync(tmp, 0o600)
    renameSync(tmp, this.secretPath)
    if (process.platform !== 'win32') chmodSync(this.secretPath, 0o600)
  }
}

export function getOrCreateAuthSecret(secretPath: string): string {
  const provider = new FileAppSecretProvider(secretPath)
  const value = provider.loadOrCreateAuthSecretSync()
  return Buffer.from(value).toString('hex')
}

export function hmacAuthSecret(authSecret: string, ...parts: string[]): string {
  return createHmac('sha256', authSecret).update(parts.join('')).digest('hex')
}
