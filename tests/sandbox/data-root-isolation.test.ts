import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildSandboxEnv } from '../../src/server/sandbox/env'

test('sandbox worker environment never inherits the application data root', () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-sandbox-runtime-'))
  const previous = process.env.CODETASK_DATA_DIR
  process.env.CODETASK_DATA_DIR = join(runtimeRoot, '..', 'private-app-data')

  try {
    const env = buildSandboxEnv({ runtimeRoot })
    assert.equal(env.CODETASK_DATA_DIR, undefined)
    assert.equal(
      Object.values(env).some((value) => value === process.env.CODETASK_DATA_DIR),
      false
    )
  } finally {
    if (previous === undefined) delete process.env.CODETASK_DATA_DIR
    else process.env.CODETASK_DATA_DIR = previous
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})

test('sandbox worker environment drops bootstrap and management credential variables', () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-sandbox-runtime-'))
  const previousSecret = process.env.CODETASK_AUTH_SECRET
  const previousCredential = process.env.CODETASK_CREDENTIAL_PATH
  process.env.CODETASK_AUTH_SECRET = 'must-not-leak'
  process.env.CODETASK_CREDENTIAL_PATH = '/private/bootstrap/credential'

  try {
    const env = buildSandboxEnv({ runtimeRoot })
    assert.equal(env.CODETASK_AUTH_SECRET, undefined)
    assert.equal(env.CODETASK_CREDENTIAL_PATH, undefined)
  } finally {
    if (previousSecret === undefined) delete process.env.CODETASK_AUTH_SECRET
    else process.env.CODETASK_AUTH_SECRET = previousSecret
    if (previousCredential === undefined) delete process.env.CODETASK_CREDENTIAL_PATH
    else process.env.CODETASK_CREDENTIAL_PATH = previousCredential
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})
