import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'

const VAULT_FORMAT_VERSION = 1
const REFERENCE_PATTERN = /^\$\{secret:([0-9a-f-]{36})\}$/i

interface EncryptedMcpSecret {
  iv: string
  ciphertext: string
  tag: string
}

interface McpSecretVaultFile {
  formatVersion: 1
  secrets: Record<string, EncryptedMcpSecret>
}

export interface McpSecretProvider {
  store(value: unknown): string
  resolve(id: string): unknown
  has(id: string): boolean
  pruneExcept(retainedIds: ReadonlySet<string>): void
}

export class MemoryMcpSecretProvider implements McpSecretProvider {
  private readonly secrets = new Map<string, unknown>()

  store(value: unknown): string {
    const id = randomUUID()
    this.secrets.set(id, structuredClone(value))
    return id
  }

  resolve(id: string): unknown {
    const normalizedId = id.toLowerCase()
    if (!this.secrets.has(normalizedId)) {
      throw new Error(`MCP secret reference is missing: ${normalizedId}`)
    }
    return structuredClone(this.secrets.get(normalizedId))
  }

  has(id: string): boolean {
    return this.secrets.has(id.toLowerCase())
  }

  pruneExcept(retainedIds: ReadonlySet<string>): void {
    const retained = new Set([...retainedIds].map((id) => id.toLowerCase()))
    for (const id of this.secrets.keys()) {
      if (!retained.has(id)) this.secrets.delete(id)
    }
  }
}

export function formatMcpSecretReference(id: string): string {
  return `\${secret:${id}}`
}

export function parseMcpSecretReference(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.match(REFERENCE_PATTERN)?.[1]?.toLowerCase() ?? null
}

function deriveVaultKey(authSecret: string): Buffer {
  const raw = /^[0-9a-f]{64}$/i.test(authSecret) ? Buffer.from(authSecret, 'hex') : authSecret
  return createHmac('sha256', raw).update('codetask:mcp-secret-vault:v1').digest()
}

function isEncryptedSecret(value: unknown): value is EncryptedMcpSecret {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.iv === 'string' &&
    typeof record.ciphertext === 'string' &&
    typeof record.tag === 'string'
  )
}

function parseVaultFile(raw: string, path: string): McpSecretVaultFile {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error(`MCP secret vault is corrupt: ${path}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`MCP secret vault is corrupt: ${path}`)
  }
  const object = value as Record<string, unknown>
  if (
    object.formatVersion !== VAULT_FORMAT_VERSION ||
    !object.secrets ||
    typeof object.secrets !== 'object' ||
    Array.isArray(object.secrets)
  ) {
    throw new Error(`MCP secret vault is corrupt: ${path}`)
  }
  const secrets = object.secrets as Record<string, unknown>
  if (Object.values(secrets).some((secret) => !isEncryptedSecret(secret))) {
    throw new Error(`MCP secret vault is corrupt: ${path}`)
  }
  return {
    formatVersion: VAULT_FORMAT_VERSION,
    secrets: secrets as Record<string, EncryptedMcpSecret>
  }
}

export class EncryptedFileMcpSecretProvider implements McpSecretProvider {
  private readonly key: Buffer

  constructor(
    private readonly path: string,
    authSecret: string
  ) {
    this.key = deriveVaultKey(authSecret)
    // Validate eagerly so startup fails closed instead of discovering corruption during a turn.
    this.readVault()
  }

  store(value: unknown): string {
    const plaintext = JSON.stringify(value)
    if (plaintext === undefined) throw new Error('MCP secret value is not JSON serializable')
    const id = randomUUID()
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(Buffer.from(id))
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const vault = this.readVault()
    vault.secrets[id] = {
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('base64')
    }
    this.writeVault(vault)
    return id
  }

  resolve(id: string): unknown {
    const normalizedId = id.toLowerCase()
    const secret = this.readVault().secrets[normalizedId]
    if (!secret) throw new Error(`MCP secret reference is missing: ${normalizedId}`)
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(secret.iv, 'base64'))
      decipher.setAAD(Buffer.from(normalizedId))
      decipher.setAuthTag(Buffer.from(secret.tag, 'base64'))
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(secret.ciphertext, 'base64')),
        decipher.final()
      ]).toString('utf8')
      return JSON.parse(plaintext) as unknown
    } catch {
      throw new Error(`MCP secret reference cannot be decrypted: ${normalizedId}`)
    }
  }

  has(id: string): boolean {
    return Object.hasOwn(this.readVault().secrets, id.toLowerCase())
  }

  pruneExcept(retainedIds: ReadonlySet<string>): void {
    const normalized = new Set([...retainedIds].map((id) => id.toLowerCase()))
    const vault = this.readVault()
    const next = Object.fromEntries(
      Object.entries(vault.secrets).filter(([id]) => normalized.has(id.toLowerCase()))
    )
    if (Object.keys(next).length === Object.keys(vault.secrets).length) return
    this.writeVault({ formatVersion: VAULT_FORMAT_VERSION, secrets: next })
  }

  private readVault(): McpSecretVaultFile {
    if (!existsSync(this.path)) return { formatVersion: VAULT_FORMAT_VERSION, secrets: {} }
    return parseVaultFile(readFileSync(this.path, 'utf8'), this.path)
  }

  private writeVault(vault: McpSecretVaultFile): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`
    let fd: number | null = null
    try {
      writeFileSync(tmp, `${JSON.stringify(vault, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      })
      if (process.platform !== 'win32') chmodSync(tmp, 0o600)
      // Windows FlushFileBuffers requires write access; 'r' fails with EPERM.
      fd = openSync(tmp, 'r+')
      fsyncSync(fd)
      closeSync(fd)
      fd = null
      renameSync(tmp, this.path)
      if (process.platform !== 'win32') chmodSync(this.path, 0o600)
      if (process.platform !== 'win32') {
        const parentFd = openSync(dirname(this.path), 'r')
        try {
          fsyncSync(parentFd)
        } finally {
          closeSync(parentFd)
        }
      }
    } finally {
      if (fd !== null) closeSync(fd)
    }
  }
}
