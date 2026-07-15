import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSetupShell } from '../../src/main/setup-shell'
import {
  StorageLocatorRepository,
  bootstrapPaths,
  readDataRootMarker,
  writeDataRootMarker
} from '../../src/main/storage-locator'
import { closeIsolatedTestDatabase, createIsolatedTestDatabase } from '../../src/server/db'

test('setup shell mounts only storage/bootstrap APIs and initializes after validation', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-setup-shell-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const candidate = join(root, 'selected-data')
  const bootstrap = bootstrapPaths(join(root, 'bootstrap-root'))
  const app = createSetupShell({
    storage: {
      phase: 'selection_required',
      dataDir: candidate,
      source: 'candidate',
      managed: false,
      bootstrap
    },
    isDev: false
  })

  assert.equal(existsSync(candidate), false)
  const jobs = await app.request('/api/jobs')
  assert.equal(jobs.status, 404)

  const validationResponse = await app.request('/api/system/storage/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: candidate })
  })
  assert.equal(validationResponse.status, 200)
  const validation = (await validationResponse.json()) as {
    data: { canonicalPath: string; nonce: string }
  }
  assert.equal(existsSync(candidate), false)

  const initializeResponse = await app.request('/api/system/storage/initialize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: validation.data.canonicalPath,
      validationNonce: validation.data.nonce
    })
  })
  assert.equal(initializeResponse.status, 200)
  assert.ok(readDataRootMarker(candidate))
  assert.equal(existsSync(join(candidate, 'db', 'app.db')), true)
  assert.equal(existsSync(bootstrap.locatorFile), true)
})

test('setup initialization rejects stale or path-swapped validation nonces', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-setup-shell-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const candidate = join(root, 'selected-data')
  const app = createSetupShell({
    storage: {
      phase: 'selection_required',
      dataDir: candidate,
      source: 'candidate',
      managed: false,
      bootstrap: bootstrapPaths(join(root, 'bootstrap-root'))
    },
    isDev: false
  })

  const response = await app.request('/api/system/storage/initialize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: candidate, validationNonce: 'forged' })
  })
  assert.equal(response.status, 409)
  assert.equal(existsSync(candidate), false)
})

test('recovery rewrites only the locator after marker and SQLite integrity validation', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-setup-recovery-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const existingData = join(root, 'existing-data')
  const marker = writeDataRootMarker(existingData, 'recovered-installation')
  const db = createIsolatedTestDatabase(existingData)
  closeIsolatedTestDatabase(db)
  const bootstrap = bootstrapPaths(join(root, 'bootstrap-root'))
  const app = createSetupShell({
    storage: {
      phase: 'recovery_required',
      dataDir: '',
      source: 'locator',
      managed: false,
      bootstrap,
      issue: 'storage_locator_unreadable'
    },
    isDev: false
  })

  const validationResponse = await app.request('/api/system/storage/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: existingData })
  })
  assert.equal(validationResponse.status, 200)
  const validation = (await validationResponse.json()) as {
    data: { canonicalPath: string; nonce: string }
  }

  const recoveryResponse = await app.request('/api/system/storage/recover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: validation.data.canonicalPath,
      validationNonce: validation.data.nonce
    })
  })
  assert.equal(recoveryResponse.status, 200)
  const locator = new StorageLocatorRepository(bootstrap).read()
  assert.equal(locator.status, 'valid')
  if (locator.status === 'valid') {
    assert.equal(locator.locator.dataDir, validation.data.canonicalPath)
    assert.equal(locator.locator.installationId, marker.installationId)
    assert.equal(locator.locator.source, 'recovered')
  }
  assert.equal(existsSync(join(existingData, 'db', 'app.db')), true)
})
