import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDatabase, closeDatabaseForTests, getDb } from '../../src/server/db'
import { generateCaptcha, verifyCaptcha } from '../../src/server/auth/captcha'

const TEST_SECRET = '0'.repeat(64)
const SCOPE = 'login:test-scope'

let dataDir: string

function setupDb(): void {
  dataDir = mkdtempSync(join(tmpdir(), 'codetask-auth-captcha-'))
  createDatabase(dataDir)
}

function teardownDb(): void {
  try {
    closeDatabaseForTests()
  } catch {
    /* best-effort, ignore errors */
  }
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* best-effort, ignore errors */
  }
}

test('generateCaptcha returns challengeId and base64 image', async () => {
  setupDb()
  try {
    const result = await generateCaptcha(TEST_SECRET, SCOPE)
    assert.ok('challengeId' in result && 'image' in result)
    if ('challengeId' in result) {
      assert.ok(result.challengeId.startsWith('cpt_'))
      assert.ok(result.image.startsWith('data:image/svg+xml;base64,'))
    }
  } finally {
    teardownDb()
  }
})

test('verifyCaptcha rejects wrong answer', async () => {
  setupDb()
  try {
    const result = await generateCaptcha(TEST_SECRET, SCOPE)
    if (!('challengeId' in result)) throw new Error('unexpected error')
    const verify = await verifyCaptcha(TEST_SECRET, result.challengeId, 'WRONG', SCOPE)
    assert.equal(verify.valid, false)
  } finally {
    teardownDb()
  }
})

test('verifyCaptcha increments attempts', async () => {
  setupDb()
  try {
    const result = await generateCaptcha(TEST_SECRET, SCOPE)
    if (!('challengeId' in result)) throw new Error('unexpected error')
    await verifyCaptcha(TEST_SECRET, result.challengeId, 'WRONG', SCOPE)
    const db = getDb()
    const client = (db as unknown as { $client: Database.Database }).$client
    const row = client
      .prepare(`SELECT attempts FROM captcha_challenge WHERE id = ?`)
      .get(result.challengeId) as { attempts: number }
    assert.equal(row.attempts, 1)
  } finally {
    teardownDb()
  }
})

test('verifyCaptcha rejects after 3 attempts', async () => {
  setupDb()
  try {
    const result = await generateCaptcha(TEST_SECRET, SCOPE)
    if (!('challengeId' in result)) throw new Error('unexpected error')
    await verifyCaptcha(TEST_SECRET, result.challengeId, 'WRONG', SCOPE)
    await verifyCaptcha(TEST_SECRET, result.challengeId, 'WRONG', SCOPE)
    await verifyCaptcha(TEST_SECRET, result.challengeId, 'WRONG', SCOPE)
    const verify = await verifyCaptcha(TEST_SECRET, result.challengeId, 'WRONG', SCOPE)
    assert.equal(verify.valid, false)
    assert.ok(verify.error?.includes('attempts'))
  } finally {
    teardownDb()
  }
})

test('verifyCaptcha sets used_at on success and rejects reuse', async () => {
  setupDb()
  try {
    const { hmacAuthSecret } = await import('../../src/server/auth/secret')

    const db = getDb()
    const client = (db as unknown as { $client: Database.Database }).$client

    const challengeId = 'cpt-test-success'
    const code = 'abcde'
    const answerHash = hmacAuthSecret(TEST_SECRET, challengeId, ':', code)
    client
      .prepare(
        `INSERT INTO captcha_challenge (id, scope_key, answer_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        challengeId,
        SCOPE,
        answerHash,
        Math.floor(Date.now() / 1000) + 300,
        Math.floor(Date.now() / 1000)
      )

    const verify = await verifyCaptcha(TEST_SECRET, challengeId, 'ABCDE', SCOPE)
    assert.equal(verify.valid, true)

    const updated = client
      .prepare(`SELECT used_at FROM captcha_challenge WHERE id = ?`)
      .get(challengeId) as { used_at: number | null }
    assert.ok(updated.used_at !== null)

    const reuse = await verifyCaptcha(TEST_SECRET, challengeId, 'ABCDE', SCOPE)
    assert.equal(reuse.valid, false)
    assert.ok(reuse.error?.includes('already used'))
  } finally {
    teardownDb()
  }
})

test('verifyCaptcha rejects expired captcha', async () => {
  setupDb()
  try {
    const result = await generateCaptcha(TEST_SECRET, SCOPE)
    if (!('challengeId' in result)) throw new Error('unexpected error')
    const db = getDb()
    const client = (db as unknown as { $client: Database.Database }).$client
    client
      .prepare(`UPDATE captcha_challenge SET expires_at = ? WHERE id = ?`)
      .run(Math.floor(Date.now() / 1000) - 60, result.challengeId)
    const verify = await verifyCaptcha(TEST_SECRET, result.challengeId, 'ABCDE', SCOPE)
    assert.equal(verify.valid, false)
    assert.ok(verify.error?.includes('expired'))
  } finally {
    teardownDb()
  }
})

test('generateCaptcha replaces existing challenge for same scope', async () => {
  setupDb()
  try {
    const { challengeId: firstId } = (await generateCaptcha(TEST_SECRET, SCOPE)) as {
      challengeId: string
    }
    const { challengeId: secondId } = (await generateCaptcha(TEST_SECRET, SCOPE)) as {
      challengeId: string
    }
    assert.notEqual(firstId, secondId)
    const db = getDb()
    const client = (db as unknown as { $client: Database.Database }).$client
    const count = client
      .prepare(`SELECT count(*) AS c FROM captcha_challenge WHERE scope_key = ?`)
      .get(SCOPE) as { c: number }
    assert.equal(count.c, 1)
  } finally {
    teardownDb()
  }
})

test('generateCaptcha rejects wrong scope during verification', async () => {
  setupDb()
  try {
    const result = await generateCaptcha(TEST_SECRET, SCOPE)
    if (!('challengeId' in result)) throw new Error('unexpected error')
    const db = getDb()
    const client = (db as unknown as { $client: Database.Database }).$client
    const row = client
      .prepare(`SELECT answer_hash FROM captcha_challenge WHERE id = ?`)
      .get(result.challengeId) as { answer_hash: string }
    client
      .prepare(
        `INSERT INTO captcha_challenge (id, scope_key, answer_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        'cpt-wrong-scope',
        'wrong:scope',
        row.answer_hash,
        Math.floor(Date.now() / 1000) + 300,
        Math.floor(Date.now() / 1000)
      )

    const verify = await verifyCaptcha(TEST_SECRET, result.challengeId, 'ABCDE', 'wrong:scope')
    assert.equal(verify.valid, false)
  } finally {
    teardownDb()
  }
})
