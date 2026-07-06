import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDatabase, closeDatabaseForTests, getDb } from '../../src/server/db'
import { generateCaptcha } from '../../src/server/auth/captcha'
import { runAuthJanitorPass } from '../../src/server/auth/janitor'

const TEST_SECRET = '0'.repeat(64)
const SCOPE = 'login:captcha-cap'

let dataDir: string

function setupDb(): void {
  dataDir = mkdtempSync(join(tmpdir(), 'codetask-captcha-cap-'))
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

test('generateCaptcha cleans expired and used rows before enforcing cap', async () => {
  setupDb()
  try {
    const db = getDb()
    const client = (db as unknown as { $client: Database.Database }).$client
    const now = Math.floor(Date.now() / 1000)

    for (let i = 0; i < 1000; i++) {
      client
        .prepare(
          `INSERT INTO captcha_challenge (id, scope_key, answer_hash, expires_at, created_at, used_at) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          `cpt-stale-${i}`,
          `scope-${i}`,
          'abc',
          now - 60,
          now - 120,
          i % 2 === 0 ? now - 30 : null
        )
    }

    const result = await generateCaptcha(TEST_SECRET, SCOPE)
    assert.ok('challengeId' in result)
  } finally {
    teardownDb()
  }
})

test('runAuthJanitorPass removes expired captcha rows immediately', async () => {
  setupDb()
  try {
    const db = getDb()
    const client = (db as unknown as { $client: Database.Database }).$client
    const now = Math.floor(Date.now() / 1000)

    client
      .prepare(
        `INSERT INTO captcha_challenge (id, scope_key, answer_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`
      )
      .run('cpt-expired', 'login:janitor', 'abc', now - 10, now - 20)

    await runAuthJanitorPass()

    const count = client.prepare(`SELECT count(*) AS c FROM captcha_challenge`).get() as {
      c: number
    }
    assert.equal(count.c, 0)
  } finally {
    teardownDb()
  }
})
