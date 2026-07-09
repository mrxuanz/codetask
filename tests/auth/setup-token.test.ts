import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { getOrCreateAuthSecret, hmacAuthSecret } from '../../src/server/auth/secret'
import { generateSetupToken, validateSetupToken } from '../../src/server/auth/setup-token'
import { dataPaths } from '../../src/server/data-paths'

test('getOrCreateAuthSecret persists and returns the same secret', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-auth-secret-'))
  try {
    const secret1 = getOrCreateAuthSecret(dataDir)
    assert.ok(typeof secret1 === 'string')
    assert.equal(secret1.length, 64)
    const secretPath = dataPaths(dataDir).secretFile
    assert.equal(existsSync(secretPath), true)
    assert.equal(readFileSync(secretPath, 'utf8').trim(), secret1)
    const secret2 = getOrCreateAuthSecret(dataDir)
    assert.equal(secret1, secret2)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('getOrCreateAuthSecret regenerates if stored value is wrong length', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-auth-secret-regen-'))
  try {
    const secretPath = dataPaths(dataDir).secretFile
    mkdirSync(dirname(secretPath), { recursive: true })
    writeFileSync(secretPath, 'short', 'utf8')
    const secret = getOrCreateAuthSecret(dataDir)
    assert.equal(secret.length, 64)
    assert.equal(readFileSync(secretPath, 'utf8').trim(), secret)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('generateSetupToken creates a valid 3-segment token', () => {
  const secret = 'a'.repeat(64)
  const { token, expiresAt } = generateSetupToken(secret)
  assert.ok(token.includes('.'))
  assert.equal(token.split('.').length, 3)
  assert.ok(expiresAt > Math.floor(Date.now() / 1000))
})

test('validateSetupToken accepts a valid token', () => {
  const secret = 'a'.repeat(64)
  const { token } = generateSetupToken(secret)
  assert.equal(validateSetupToken(secret, token), true)
})

test('validateSetupToken rejects token signed with different secret', () => {
  const { token } = generateSetupToken('a'.repeat(64))
  assert.equal(validateSetupToken('b'.repeat(64), token), false)
})

test('validateSetupToken rejects tampered token', () => {
  const secret = 'a'.repeat(64)
  const { token } = generateSetupToken(secret)
  const parts = token.split('.')
  parts[1] = String(Number(parts[1]) + 100)
  assert.equal(validateSetupToken(secret, parts.join('.')), false)
})

test('validateSetupToken rejects expired token', () => {
  const secret = 'a'.repeat(64)
  const { token } = generateSetupToken(secret)
  const parts = token.split('.')
  parts[1] = String(Math.floor(Date.now() / 1000) - 3600)
  const mac = hmacAuthSecret(secret, `${parts[0]}:${parts[1]}`)
  const expired = `${parts[0]}.${parts[1]}.${mac}`
  assert.equal(validateSetupToken(secret, expired), false)
})

test('hmacAuthSecret produces consistent HMAC', () => {
  const secret = 'test-secret'
  const h1 = hmacAuthSecret(secret, 'ip:', '127.0.0.1')
  const h2 = hmacAuthSecret(secret, 'ip:', '127.0.0.1')
  assert.equal(h1, h2)
  const h3 = hmacAuthSecret(secret, 'ip:', '192.168.1.1')
  assert.notEqual(h1, h3)
})
