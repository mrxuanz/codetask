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
    isDev: false,
    setupTokenRequired: true
  })

  assert.equal(existsSync(candidate), false)
  const jobs = await app.request('/api/jobs')
  assert.equal(jobs.status, 404)

  const bootstrapResponse = await app.request('/api/bootstrap')
  assert.equal(bootstrapResponse.status, 200)
  const bootstrapBody = (await bootstrapResponse.json()) as {
    data: { setupTokenRequired: boolean; storagePhase: string }
  }
  assert.equal(bootstrapBody.data.setupTokenRequired, true)
  assert.equal(bootstrapBody.data.storagePhase, 'selection_required')

  const browseResponse = await app.request('/api/fs/browse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ partialPath: root })
  })
  assert.equal(browseResponse.status, 200)

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
  const initialized = (await initializeResponse.json()) as {
    data: { phase: string; dataDir: string }
  }
  assert.equal(initialized.data.phase, 'ready')
  assert.ok(readDataRootMarker(candidate))
  assert.equal(existsSync(join(candidate, 'db', 'app.db')), true)
  assert.equal(existsSync(bootstrap.locatorFile), true)
})

test('setup initialize awaits activateStorage before returning ready', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-setup-activate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const candidate = join(root, 'selected-data')
  let activatedAt = 0
  const app = createSetupShell({
    storage: {
      phase: 'selection_required',
      dataDir: candidate,
      source: 'candidate',
      managed: false,
      bootstrap: bootstrapPaths(join(root, 'bootstrap-root'))
    },
    isDev: false,
    activateStorage: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      activatedAt = Date.now()
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
  const before = Date.now()
  const initializeResponse = await app.request('/api/system/storage/initialize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: validation.data.canonicalPath,
      validationNonce: validation.data.nonce
    })
  })
  const after = Date.now()
  assert.equal(initializeResponse.status, 200)
  assert.ok(activatedAt >= before)
  assert.ok(activatedAt <= after)
  const body = (await initializeResponse.json()) as { data: { phase: string } }
  assert.equal(body.data.phase, 'ready')
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
  const recovered = (await recoveryResponse.json()) as { data: { phase: string } }
  assert.equal(recovered.data.phase, 'ready')
  const locator = new StorageLocatorRepository(bootstrap).read()
  assert.equal(locator.status, 'valid')
  if (locator.status === 'valid') {
    assert.equal(locator.locator.dataDir, validation.data.canonicalPath)
    assert.equal(locator.locator.installationId, marker.installationId)
    assert.equal(locator.locator.source, 'recovered')
  }
  assert.equal(existsSync(join(existingData, 'db', 'app.db')), true)
})

test('first-run selection adopts an already initialized CodeTask data directory', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-setup-adopt-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const existingData = join(root, 'existing-data')
  const marker = writeDataRootMarker(existingData, 'existing-installation')
  const db = createIsolatedTestDatabase(existingData)
  closeIsolatedTestDatabase(db)
  const bootstrap = bootstrapPaths(join(root, 'shared-bootstrap'))
  const app = createSetupShell({
    storage: {
      phase: 'selection_required',
      dataDir: join(root, 'new-data'),
      source: 'candidate',
      managed: false,
      bootstrap
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
  const locator = new StorageLocatorRepository(bootstrap).read()
  assert.equal(locator.status, 'valid')
  if (locator.status === 'valid') {
    assert.equal(locator.locator.dataDir, validation.data.canonicalPath)
    assert.equal(locator.locator.installationId, marker.installationId)
  }
})
