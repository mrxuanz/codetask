import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  EncryptedFileAppSecretProvider,
  getOrCreateAuthSecret,
  hmacAuthSecret,
  inspectStoredAppSecret,
  resolveAppSecretStorageKind
} from '../../src/server/auth/secret'
import { generateSetupToken, validateSetupToken } from '../../src/server/auth/setup-token'

test('getOrCreateAuthSecret persists and returns the same secret', () => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-auth-secret-'))
  try {
    const secretPath = join(root, 'bootstrap', 'secrets', 'auth-secret')
    const secret1 = getOrCreateAuthSecret(secretPath)
    assert.ok(typeof secret1 === 'string')
    assert.equal(secret1.length, 64)
    assert.equal(existsSync(secretPath), true)
    assert.equal(readFileSync(secretPath, 'utf8').trim(), secret1)
    const secret2 = getOrCreateAuthSecret(secretPath)
    assert.equal(secret1, secret2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('getOrCreateAuthSecret fails closed if stored value is corrupt', () => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-auth-secret-regen-'))
  try {
    const secretPath = join(root, 'bootstrap', 'secrets', 'auth-secret')
    mkdirSync(dirname(secretPath), { recursive: true })
    writeFileSync(secretPath, 'short', 'utf8')
    assert.throws(() => getOrCreateAuthSecret(secretPath), /Auth secret is corrupt/)
    assert.equal(readFileSync(secretPath, 'utf8').trim(), 'short')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('encrypted secret provider creates a sealed value and rejects plaintext files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-auth-secret-encrypted-'))
  const encryptedPath = join(root, 'bootstrap', 'secrets', 'auth-secret')
  const plaintextPath = join(root, 'bootstrap', 'secrets', 'plaintext-auth-secret')
  const cipher = {
    encrypt: (plaintext: string): Uint8Array => Buffer.from(`sealed:${plaintext}`, 'utf8'),
    decrypt: (ciphertext: Uint8Array): string => {
      const value = Buffer.from(ciphertext).toString('utf8')
      if (!value.startsWith('sealed:')) throw new Error('invalid cipher fixture')
      return value.slice('sealed:'.length)
    }
  }
  try {
    const provider = new EncryptedFileAppSecretProvider(encryptedPath, cipher)
    const secret = Buffer.from(await provider.loadOrCreateAuthSecret()).toString('hex')
    assert.equal(secret.length, 64)
    assert.equal(provider.describeStorage().kind, 'os_store')
    assert.equal(inspectStoredAppSecret(encryptedPath), 'encrypted')
    assert.doesNotMatch(readFileSync(encryptedPath, 'utf8'), new RegExp(secret))

    const reloaded = new EncryptedFileAppSecretProvider(encryptedPath, cipher)
    assert.equal(Buffer.from(await reloaded.loadOrCreateAuthSecret()).toString('hex'), secret)

    mkdirSync(dirname(plaintextPath), { recursive: true })
    writeFileSync(plaintextPath, 'b'.repeat(64), 'utf8')
    await assert.rejects(
      () => new EncryptedFileAppSecretProvider(plaintextPath, cipher).loadOrCreateAuthSecret(),
      /Encrypted auth secret is corrupt/
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('shared auth secret selects its existing format instead of the launch mode', () => {
  assert.equal(resolveAppSecretStorageKind('missing', true), 'os_store')
  assert.equal(resolveAppSecretStorageKind('missing', false), 'fallback_file')
  assert.equal(resolveAppSecretStorageKind('plaintext', true), 'fallback_file')
  assert.equal(resolveAppSecretStorageKind('encrypted', true), 'os_store')
  assert.throws(() => resolveAppSecretStorageKind('encrypted', false), /requires OS secret storage/)
  assert.throws(() => resolveAppSecretStorageKind('invalid', true), /format is invalid/)
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
