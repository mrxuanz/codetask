import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'

/**
 * Installation / auth secret ownership (Batch E).
 * Product code must not read CODETASK_* env for keys — use this provider instead.
 */
export interface SecretKeyProvider {
  getOrCreateInstallationKey(): Promise<Uint8Array>
  getAuthSecret(): Promise<Uint8Array>
}

export type FileSecretKeyProviderOptions = {
  dataDir: string
  /** Durable auth secret hex from SQLite `auth_secret` (64 hex chars). */
  authSecretHex: string
  /**
   * Optional recovery key file (headless). Absolute path to a file containing
   * 64 hex chars or arbitrary UTF-8 (hashed). Never pass raw secrets on argv.
   */
  masterKeyFile?: string
}

function installationKeyPath(dataDir: string): string {
  return join(dataDir, 'secrets', 'installation.key')
}

function normalizeToKeyBytes(raw: string): Uint8Array {
  const trimmed = raw.trim()
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return new Uint8Array(Buffer.from(trimmed, 'hex'))
  }
  return new Uint8Array(createHash('sha256').update(trimmed, 'utf8').digest())
}

function readKeyFile(path: string): Uint8Array {
  const raw = readFileSync(path, 'utf8')
  return normalizeToKeyBytes(raw)
}

function writeKeyFile(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true })
  const hex = Buffer.from(bytes).toString('hex')
  writeFileSync(path, `${hex}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows may ignore mode; best-effort.
  }
}

export class FileSecretKeyProvider implements SecretKeyProvider {
  constructor(private readonly options: FileSecretKeyProviderOptions) {}

  /** Sync helper for host composition paths that are not yet async. */
  getOrCreateInstallationKeySync(): Uint8Array {
    if (this.options.masterKeyFile) {
      if (!existsSync(this.options.masterKeyFile)) {
        throw new Error(`master-key-file not found: ${this.options.masterKeyFile}`)
      }
      return readKeyFile(this.options.masterKeyFile)
    }

    const path = installationKeyPath(this.options.dataDir)
    if (existsSync(path)) {
      return readKeyFile(path)
    }

    // Bootstrap installation key from durable auth secret so existing encrypted
    // settings remain readable, then persist for future boots.
    const fromAuth = normalizeToKeyBytes(this.options.authSecretHex)
    writeKeyFile(path, fromAuth)
    return fromAuth
  }

  getAuthSecretSync(): Uint8Array {
    return normalizeToKeyBytes(this.options.authSecretHex)
  }

  getOrCreateInstallationKey(): Promise<Uint8Array> {
    return Promise.resolve(this.getOrCreateInstallationKeySync())
  }

  getAuthSecret(): Promise<Uint8Array> {
    return Promise.resolve(this.getAuthSecretSync())
  }
}

export function createFileSecretKeyProvider(
  options: FileSecretKeyProviderOptions
): FileSecretKeyProvider {
  return new FileSecretKeyProvider(options)
}

/** Hex encoding for APIs that still accept masterKey as string. */
export function keyBytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

export function generateInstallationKeyBytes(): Uint8Array {
  return new Uint8Array(randomBytes(32))
}
