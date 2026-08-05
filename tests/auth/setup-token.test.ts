import assert from 'node:assert/strict'
import test from 'node:test'
import { hmacAuthSecret, readSqliteAuthSecret } from '../../src/server/auth/secret'
import {
  clearProcessSetupGate,
  createProcessSetupGateSecret,
  generateSetupToken,
  installProcessSetupGate,
  validateSetupToken,
  validateSetupTokenWithGate
} from '../../src/server/auth/setup-token'
import { migration040DestructiveAuthCurrent } from '../../packages/database/src/migrations/v001_042/040_destructive_auth_current.ts'
import { migration041AuthSecretSqlite } from '../../packages/database/src/migrations/v001_042/041_auth_secret_sqlite.ts'
import { NodeSqliteAdapter } from '../helpers/node-sqlite-adapter'

test('SQLite owns one stable auth secret for both Hono hosts', () => {
  const db = new NodeSqliteAdapter()
  try {
    migration040DestructiveAuthCurrent.up(db as never)
    migration041AuthSecretSqlite.up(db as never)
    const first = readSqliteAuthSecret(db as never)
    migration041AuthSecretSqlite.up(db as never)
    const second = readSqliteAuthSecret(db as never)

    assert.match(first, /^[a-f0-9]{64}$/u)
    assert.equal(second, first)
    assert.equal(
      (db.prepare(`SELECT count(*) AS count FROM auth_secret`).get() as { count: number }).count,
      1
    )
  } finally {
    db.close()
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

test('validateSetupTokenWithGate accepts process gate before durable auth secret exists', () => {
  const gate = createProcessSetupGateSecret()
  installProcessSetupGate(gate)
  try {
    const { token } = generateSetupToken(gate)
    assert.equal(validateSetupTokenWithGate('b'.repeat(64), token), true)
    assert.equal(validateSetupToken('b'.repeat(64), token), false)
  } finally {
    clearProcessSetupGate()
  }
})

test('validateSetupTokenWithGate falls back to durable auth secret', () => {
  clearProcessSetupGate()
  const secret = 'a'.repeat(64)
  const { token } = generateSetupToken(secret)
  assert.equal(validateSetupTokenWithGate(secret, token), true)
})

test('hmacAuthSecret produces consistent HMAC', () => {
  const secret = 'test-secret'
  const h1 = hmacAuthSecret(secret, 'ip:', '127.0.0.1')
  const h2 = hmacAuthSecret(secret, 'ip:', '127.0.0.1')
  assert.equal(h1, h2)
  const h3 = hmacAuthSecret(secret, 'ip:', '192.168.1.1')
  assert.notEqual(h1, h3)
})
