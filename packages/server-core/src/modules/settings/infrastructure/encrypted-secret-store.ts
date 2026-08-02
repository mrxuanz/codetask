import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { SettingsError } from '../domain/settings-errors.ts'
import type { SecretMeta, SecretStore } from '../ports/secret-store.ts'

interface SecretRow {
  id: string
  name: string
  backend: string
  external_ref: string | null
  ciphertext: string
  nonce: string
  auth_tag: string
  created_at: number
  updated_at: number
}

const BACKEND = 'encrypted'
const NONCE_BYTES = 12

function deriveKey(masterKey: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(masterKey)) {
    return Buffer.from(masterKey, 'hex')
  }
  return createHash('sha256').update(masterKey, 'utf8').digest()
}

export class EncryptedSecretStore implements SecretStore {
  private readonly key: Buffer | null

  constructor(
    private readonly client: Database.Database,
    masterKey?: string
  ) {
    this.key = masterKey ? deriveKey(masterKey) : null
    this.ensureSchema()
  }

  put(name: string, value: string): void {
    this.requireMasterKey()
    const trimmed = name.trim()
    if (!trimmed) {
      throw SettingsError.badRequest('settings.invalid_payload', 'Secret name is required')
    }

    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.key!, nonce)
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const authTag = cipher.getAuthTag()
    const now = Math.floor(Date.now() / 1000)
    const existing = this.client
      .prepare(`SELECT id FROM setting_secrets WHERE name = ?`)
      .get(trimmed) as { id: string } | undefined

    if (existing) {
      this.client
        .prepare(
          `UPDATE setting_secrets
              SET ciphertext = ?, nonce = ?, auth_tag = ?, updated_at = ?
            WHERE name = ?`
        )
        .run(encrypted.toString('base64'), nonce.toString('base64'), authTag.toString('base64'), now, trimmed)
      return
    }

    this.client
      .prepare(
        `INSERT INTO setting_secrets (
           id, name, backend, external_ref, ciphertext, nonce, auth_tag, created_at, updated_at
         ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        trimmed,
        BACKEND,
        encrypted.toString('base64'),
        nonce.toString('base64'),
        authTag.toString('base64'),
        now,
        now
      )
  }

  get(name: string): string | null {
    this.requireMasterKey()
    const row = this.client
      .prepare(
        `SELECT id, name, backend, external_ref, ciphertext, nonce, auth_tag, created_at, updated_at
           FROM setting_secrets
          WHERE name = ?`
      )
      .get(name.trim()) as SecretRow | undefined
    if (!row) return null
    return this.decrypt(row)
  }

  delete(name: string): void {
    this.requireMasterKey()
    this.client.prepare(`DELETE FROM setting_secrets WHERE name = ?`).run(name.trim())
  }

  list(): SecretMeta[] {
    const rows = this.client
      .prepare(
        `SELECT name, backend
           FROM setting_secrets
          ORDER BY name ASC`
      )
      .all() as Array<{ name: string; backend: string }>
    return rows.map((row) => ({
      name: row.name,
      backend: row.backend,
      configured: true
    }))
  }

  has(name: string): boolean {
    const row = this.client
      .prepare(`SELECT 1 AS ok FROM setting_secrets WHERE name = ? LIMIT 1`)
      .get(name.trim()) as { ok: number } | undefined
    return Boolean(row)
  }

  private decrypt(row: SecretRow): string {
    this.requireMasterKey()
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key!,
      Buffer.from(row.nonce, 'base64')
    )
    decipher.setAuthTag(Buffer.from(row.auth_tag, 'base64'))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext, 'base64')),
      decipher.final()
    ])
    return plaintext.toString('utf8')
  }

  private requireMasterKey(): void {
    if (!this.key) {
      throw SettingsError.badRequest(
        'settings.invalid_payload',
        'Secret store requires a configured master key'
      )
    }
  }

  private ensureSchema(): void {
    this.client.exec(`
      CREATE TABLE IF NOT EXISTS setting_secrets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        backend TEXT NOT NULL,
        external_ref TEXT,
        ciphertext TEXT NOT NULL,
        nonce TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
  }
}
