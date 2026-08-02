import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSetupShell } from '../../src/main/setup-shell'
import { closeIsolatedTestDatabase, createIsolatedTestDatabase } from '../../src/server/db'

function selection(dataDir: string): {
  phase: 'selection_required'
  dataDir: string
  source: 'candidate'
} {
  return { phase: 'selection_required', dataDir, source: 'candidate' }
}

test('setup shell bootstrap requires setup token when configured for server mode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-setup-token-flag-'))
  const candidate = join(root, 'selected-data')
  const app = createSetupShell({
    storage: selection(candidate),
    isDev: false,
    setupTokenRequired: true
  })

  const response = await app.request('/api/auth/bootstrap')
  assert.equal(response.status, 200)
  const body = (await response.json()) as {
    data?: { setupTokenRequired?: boolean; storagePhase?: string; initialized?: boolean }
  }
  assert.equal(body.data?.initialized, false)
  assert.equal(body.data?.setupTokenRequired, true)
  assert.equal(body.data?.storagePhase, 'selection_required')
  rmSync(root, { recursive: true, force: true })
})

test('setup shell initializes only db and assets after validation', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-setup-shell-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const candidate = join(root, 'selected-data')
  const app = createSetupShell({
    storage: selection(candidate),
    isDev: false,
    setupTokenRequired: true
  })

  assert.equal(existsSync(candidate), false)
  assert.equal((await app.request('/api/jobs')).status, 404)

  const validationResponse = await app.request('/api/system/storage/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: candidate })
  })
  assert.equal(validationResponse.status, 200)
  const validation = (await validationResponse.json()) as {
    data: { canonicalPath: string; nonce: string }
  }

  const initializeResponse = await app.request('/api/system/storage/initialize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: validation.data.canonicalPath,
      validationNonce: validation.data.nonce
    })
  })
  assert.equal(initializeResponse.status, 200)
  assert.equal(existsSync(join(candidate, 'db', 'app.db')), true)
  assert.deepEqual(readdirSync(candidate).sort(), ['assets', 'db'])
})

test('setup initialize persists dbPath source before activating storage', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-setup-activate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const candidate = join(root, 'selected-data')
  const stages: string[] = []
  const app = createSetupShell({
    storage: selection(candidate),
    isDev: false,
    persistDataDir: (dataDir) => {
      assert.equal(dataDir, realpathSync(candidate))
      stages.push('persist')
    },
    activateStorage: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      stages.push('activate')
    }
  })

  const validationResponse = await app.request('/api/system/storage/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: candidate })
  })
  const validation = (await validationResponse.json()) as {
    data: { canonicalPath: string; nonce: string }
  }
  const response = await app.request('/api/system/storage/initialize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: validation.data.canonicalPath,
      validationNonce: validation.data.nonce
    })
  })
  assert.equal(response.status, 200)
  assert.deepEqual(stages, ['persist', 'activate'])
})

test('setup initialization rejects a forged validation nonce', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-setup-nonce-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const candidate = join(root, 'selected-data')
  const app = createSetupShell({ storage: selection(candidate), isDev: false })

  const response = await app.request('/api/system/storage/initialize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: candidate, validationNonce: 'forged' })
  })
  assert.equal(response.status, 409)
  assert.equal(existsSync(candidate), false)
})

test('first-run selection can adopt an existing valid SQLite data directory', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-setup-adopt-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const existingData = join(root, 'existing-data')
  const db = createIsolatedTestDatabase(existingData)
  closeIsolatedTestDatabase(db)
  let persistedDataDir = ''
  const app = createSetupShell({
    storage: selection(join(root, 'new-data')),
    isDev: false,
    persistDataDir: (dataDir) => {
      persistedDataDir = dataDir
    }
  })

  const validationResponse = await app.request('/api/system/storage/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: existingData })
  })
  const validation = (await validationResponse.json()) as {
    data: { action: string; canonicalPath: string; nonce: string }
  }
  assert.equal(validation.data.action, 'recover')

  const recoveryResponse = await app.request('/api/system/storage/recover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: validation.data.canonicalPath,
      validationNonce: validation.data.nonce
    })
  })
  assert.equal(recoveryResponse.status, 200)
  assert.equal(persistedDataDir, realpathSync(existingData))
})
