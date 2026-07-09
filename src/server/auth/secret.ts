import { randomBytes, createHmac } from 'crypto'
import { existsSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { dataPaths } from '../data-paths'

const SECRET_LENGTH = 32

function generateSecret(): string {
  return randomBytes(SECRET_LENGTH).toString('hex')
}

export function getOrCreateAuthSecret(dataDir: string): string {
  const secretPath = dataPaths(dataDir).secretFile

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

  mkdirSync(dirname(secretPath), { recursive: true })
  const secret = generateSecret()
  writeFileSync(secretPath, secret, { encoding: 'utf8', mode: 0o600 })
  chmodSync(secretPath, 0o600)
  return secret
}

export function hmacAuthSecret(authSecret: string, ...parts: string[]): string {
  return createHmac('sha256', authSecret).update(parts.join('')).digest('hex')
}
