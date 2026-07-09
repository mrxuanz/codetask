import { randomBytes, createHmac } from 'crypto'
import { existsSync, chmodSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const SECRET_KEY = 'security.authSecretV1'
const SECRET_LENGTH = 32

function generateSecret(): string {
  return randomBytes(SECRET_LENGTH).toString('hex')
}

function secretFilePath(dataDir: string): string {
  return join(dataDir, 'auth-secret')
}

export function getOrCreateAuthSecret(
  settings: {
    read(): Record<string, unknown>
    patch(mutator: (file: Record<string, unknown>) => void): void
  },
  dataDir: string
): string {
  const secretPath = secretFilePath(dataDir)

  if (existsSync(secretPath)) {
    try {
      const existing = readFileSync(secretPath, 'utf8').trim()
      if (existing.length === SECRET_LENGTH * 2) {
        chmodSync(secretPath, 0o600)
        return existing
      }
    } catch {
      // corrupt file, regenerate below
    }
  }

  const secret = generateSecret()
  writeFileSync(secretPath, secret, { encoding: 'utf8', mode: 0o600 })
  chmodSync(secretPath, 0o600)

  const file = settings.read()
  if (typeof file[SECRET_KEY] !== 'string' || file[SECRET_KEY] !== secret) {
    settings.patch((f) => {
      f[SECRET_KEY] = secret
    })
  }

  return secret
}

export function hmacAuthSecret(authSecret: string, ...parts: string[]): string {
  return createHmac('sha256', authSecret).update(parts.join('')).digest('hex')
}
