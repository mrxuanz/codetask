import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'

import { getDb, createDatabase, closeDatabaseForTests } from '../../src/server/db'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  checkGuardState,
  recordLoginFailure,
  resetGuardState,
  recordRateBucket,
  deleteCaptchaForScope
} from '../../src/server/auth/guard'

let dataDir: string

function setupDb(): void {
  dataDir = mkdtempSync(join(tmpdir(), 'codetask-auth-guard-'))
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

test('initial guard state returns allowed with no captcha required', () => {
  setupDb()
  try {
    const state = checkGuardState()
    assert.equal(state.allowed, true)
    assert.equal(state.captchaRequired, false)
    assert.equal(state.lockedUntil, null)
  } finally {
    teardownDb()
  }
})

test('1-4 failures do not require captcha', () => {
  setupDb()
  try {
    for (let i = 0; i < 4; i++) {
      recordLoginFailure()
    }
    const state = checkGuardState()
    assert.equal(state.allowed, true)
    assert.equal(state.captchaRequired, false)
  } finally {
    teardownDb()
  }
})

test('5 failures require captcha', () => {
  setupDb()
  try {
    for (let i = 0; i < 5; i++) {
      recordLoginFailure()
    }
    const state = checkGuardState()
    assert.equal(state.allowed, true)
    assert.equal(state.captchaRequired, true)
  } finally {
    teardownDb()
  }
})

test('6-9 failures require captcha with increasing backoff delay', () => {
  setupDb()
  try {
    for (let i = 0; i < 9; i++) {
      recordLoginFailure()
    }
    const state = checkGuardState()
    assert.equal(state.allowed, false)
    assert.ok(state.lockedUntil !== null)
    assert.ok(state.retryAfterSec > 0 && state.retryAfterSec <= 10)
  } finally {
    teardownDb()
  }
})

test('10-14 failures lock for 15 minutes', () => {
  setupDb()
  try {
    for (let i = 0; i < 10; i++) {
      recordLoginFailure()
    }
    const state = checkGuardState()
    assert.equal(state.allowed, false)
    assert.equal(state.captchaRequired, false)
    assert.ok(state.lockedUntil !== null)
    assert.ok(state.retryAfterSec > 0)
  } finally {
    teardownDb()
  }
})

test('15+ failures lock for 30 minutes', () => {
  setupDb()
  try {
    for (let i = 0; i < 15; i++) {
      recordLoginFailure()
    }
    const state = checkGuardState()
    assert.equal(state.allowed, false)
    assert.ok(state.retryAfterSec >= 30 * 60 - 5)
  } finally {
    teardownDb()
  }
})

test('successful login resets guard state', () => {
  setupDb()
  try {
    for (let i = 0; i < 10; i++) {
      recordLoginFailure()
    }
    let state = checkGuardState()
    assert.equal(state.allowed, false)

    resetGuardState()
    state = checkGuardState()
    assert.equal(state.allowed, true)
    assert.equal(state.captchaRequired, false)
    assert.equal(state.lockedUntil, null)
  } finally {
    teardownDb()
  }
})

test('rate bucket records entries', () => {
  setupDb()
  try {
    recordRateBucket('test-bucket', 10)
    recordRateBucket('test-bucket', 10)
  } finally {
    teardownDb()
  }
})

test('deleteCaptchaForScope removes challenges', () => {
  setupDb()
  try {
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    const client = (db as unknown as { $client: Database.Database }).$client
    client
      .prepare(
        `INSERT INTO captcha_challenge (id, scope_key, answer_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`
      )
      .run('cpt-test', 'login:test', 'abc', now + 300, now)

    let count = client
      .prepare(`SELECT count(*) AS c FROM captcha_challenge WHERE scope_key = ?`)
      .get('login:test') as { c: number }
    assert.equal(count.c, 1)

    deleteCaptchaForScope('login:test')

    count = client
      .prepare(`SELECT count(*) AS c FROM captcha_challenge WHERE scope_key = ?`)
      .get('login:test') as { c: number }
    assert.equal(count.c, 0)
  } finally {
    teardownDb()
  }
})
