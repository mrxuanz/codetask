import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  StorageLocatorRepository,
  bootstrapPaths,
  createStorageLocator,
  ensureResolvedDataRoot,
  readDataRootMarker,
  resolveStorageLocation,
  writeDataRootMarker
} from '../../src/main/storage-locator'

function fixture(t: test.TestContext): { root: string; bootstrapRoot: string; candidate: string } {
  const root = mkdtempSync(join(tmpdir(), 'codetask-storage-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return {
    root,
    bootstrapRoot: join(root, 'bootstrap-root'),
    candidate: join(root, 'candidate')
  }
}

test('storage source priority is CLI > env > locator > candidate', (t) => {
  const f = fixture(t)
  const locatorData = join(f.root, 'locator-data')
  const marker = writeDataRootMarker(locatorData)
  new StorageLocatorRepository(bootstrapPaths(f.bootstrapRoot)).write(
    createStorageLocator({
      dataDir: locatorData,
      source: 'desktop_setup',
      installationId: marker.installationId
    })
  )

  const cli = resolveStorageLocation({
    explicitDataDir: join(f.root, 'cli-data'),
    envDataDir: join(f.root, 'env-data'),
    mode: 'desktop',
    bootstrapRoot: f.bootstrapRoot,
    defaultDataDir: f.candidate
  })
  assert.equal(cli.source, 'cli')

  const env = resolveStorageLocation({
    envDataDir: join(f.root, 'env-data'),
    mode: 'desktop',
    bootstrapRoot: f.bootstrapRoot,
    defaultDataDir: f.candidate
  })
  assert.equal(env.source, 'env')

  const locator = resolveStorageLocation({
    mode: 'desktop',
    bootstrapRoot: f.bootstrapRoot,
    defaultDataDir: f.candidate
  })
  assert.equal(locator.source, 'locator')
  assert.equal(locator.phase, 'ready')
})

test('corrupt locator fails closed without selecting an empty database', (t) => {
  const f = fixture(t)
  const paths = bootstrapPaths(f.bootstrapRoot)
  mkdirSync(paths.bootstrapDir, { recursive: true })
  writeFileSync(paths.locatorFile, '{not-json', 'utf8')

  const result = resolveStorageLocation({
    mode: 'desktop',
    bootstrapRoot: f.bootstrapRoot,
    defaultDataDir: f.candidate
  })
  assert.equal(result.phase, 'recovery_required')
  assert.equal(result.issue, 'storage_locator_unreadable')
  assert.equal(result.dataDir, '')
})

test('locator and marker installation ids must match', (t) => {
  const f = fixture(t)
  const dataDir = join(f.root, 'data')
  writeDataRootMarker(dataDir, 'install-a')
  new StorageLocatorRepository(bootstrapPaths(f.bootstrapRoot)).write(
    createStorageLocator({
      dataDir,
      source: 'desktop_setup',
      installationId: 'install-b'
    })
  )

  const result = resolveStorageLocation({
    mode: 'desktop',
    bootstrapRoot: f.bootstrapRoot,
    defaultDataDir: f.candidate
  })
  assert.equal(result.phase, 'recovery_required')
  assert.equal(result.issue, 'storage_installation_id_mismatch')
})

test('an unmarked DB at the old candidate path is not claimed or imported', (t) => {
  const f = fixture(t)
  mkdirSync(join(f.candidate, 'db'), { recursive: true })
  writeFileSync(join(f.candidate, 'db', 'app.db'), 'legacy-fixture')

  const result = resolveStorageLocation({
    mode: 'desktop',
    bootstrapRoot: f.bootstrapRoot,
    defaultDataDir: f.candidate
  })
  assert.equal(result.phase, 'selection_required')
  assert.equal(result.source, 'candidate')
  assert.equal(readDataRootMarker(f.candidate), null)
  assert.equal(
    new StorageLocatorRepository(bootstrapPaths(f.bootstrapRoot)).read().status,
    'missing'
  )
})

test('an explicitly selected non-empty old root requires deliberate recovery', (t) => {
  const f = fixture(t)
  mkdirSync(join(f.candidate, 'db'), { recursive: true })
  writeFileSync(join(f.candidate, 'db', 'app.db'), 'old-fixture')

  const result = resolveStorageLocation({
    explicitDataDir: f.candidate,
    mode: 'desktop',
    bootstrapRoot: f.bootstrapRoot,
    defaultDataDir: join(f.root, 'new-candidate')
  })
  assert.equal(result.phase, 'ready')
  assert.throws(() => ensureResolvedDataRoot(result), /non-empty directory/)
  assert.equal(readDataRootMarker(f.candidate), null)
})

test('first desktop run returns a candidate without creating it', (t) => {
  const f = fixture(t)
  const result = resolveStorageLocation({
    mode: 'desktop',
    bootstrapRoot: f.bootstrapRoot,
    defaultDataDir: f.candidate
  })
  assert.equal(result.phase, 'selection_required')
  assert.equal(result.source, 'candidate')
  assert.equal(readDataRootMarker(f.candidate), null)
})

test('headless server first run returns selection_required like desktop', (t) => {
  const f = fixture(t)
  const result = resolveStorageLocation({
    mode: 'server',
    bootstrapRoot: f.bootstrapRoot,
    defaultDataDir: f.candidate
  })
  assert.equal(result.phase, 'selection_required')
  assert.equal(result.source, 'candidate')
  assert.equal(result.managed, false)
  assert.equal(result.issue, undefined)
})

test('shared bootstrap adopts a valid legacy desktop locator and secrets', (t) => {
  const f = fixture(t)
  const sharedBootstrapRoot = join(f.root, 'shared-bootstrap')
  const legacyBootstrapRoot = join(f.root, 'legacy-desktop-bootstrap')
  const legacyPaths = bootstrapPaths(legacyBootstrapRoot)
  const dataDir = join(f.root, 'existing-data')
  const marker = writeDataRootMarker(dataDir, 'shared-installation')
  new StorageLocatorRepository(legacyPaths).write(
    createStorageLocator({
      dataDir,
      source: 'desktop_setup',
      installationId: marker.installationId
    })
  )
  mkdirSync(legacyPaths.secretsDir, { recursive: true })
  writeFileSync(legacyPaths.authSecretFile, 'legacy-auth-secret', { mode: 0o600 })
  writeFileSync(legacyPaths.mcpSecretFile, '{"legacy":true}\n', { mode: 0o600 })

  const result = resolveStorageLocation({
    mode: 'server',
    bootstrapRoot: sharedBootstrapRoot,
    legacyBootstrapRoots: [legacyBootstrapRoot],
    defaultDataDir: f.candidate
  })

  assert.equal(result.phase, 'ready')
  assert.equal(result.dataDir, dataDir)
  const sharedPaths = bootstrapPaths(sharedBootstrapRoot)
  const locator = new StorageLocatorRepository(sharedPaths).read()
  assert.equal(locator.status, 'valid')
  if (locator.status === 'valid') {
    assert.equal(locator.locator.source, 'migration')
    assert.equal(locator.locator.installationId, marker.installationId)
  }
  assert.equal(readFileSync(sharedPaths.authSecretFile, 'utf8'), 'legacy-auth-secret')
  assert.equal(readFileSync(sharedPaths.mcpSecretFile, 'utf8'), '{"legacy":true}\n')
})

test('conflicting legacy bootstrap locators require deliberate recovery', (t) => {
  const f = fixture(t)
  const legacyRoots = [join(f.root, 'legacy-a'), join(f.root, 'legacy-b')]
  for (const [index, legacyRoot] of legacyRoots.entries()) {
    const dataDir = join(f.root, `data-${index}`)
    const marker = writeDataRootMarker(dataDir, `installation-${index}`)
    new StorageLocatorRepository(bootstrapPaths(legacyRoot)).write(
      createStorageLocator({
        dataDir,
        source: 'desktop_setup',
        installationId: marker.installationId
      })
    )
  }

  const result = resolveStorageLocation({
    mode: 'desktop',
    bootstrapRoot: join(f.root, 'shared-bootstrap'),
    legacyBootstrapRoots: legacyRoots,
    defaultDataDir: f.candidate
  })

  assert.equal(result.phase, 'recovery_required')
  assert.equal(result.issue, 'storage_legacy_locator_conflict')
})

test('stale locator with empty data root soft-downgrades to selection_required', (t) => {
  const f = fixture(t)
  const dataDir = join(f.root, 'data')
  mkdirSync(dataDir, { recursive: true })
  new StorageLocatorRepository(bootstrapPaths(f.bootstrapRoot)).write(
    createStorageLocator({
      dataDir,
      source: 'desktop_setup',
      installationId: 'stale-install'
    })
  )

  const result = resolveStorageLocation({
    mode: 'desktop',
    bootstrapRoot: f.bootstrapRoot,
    defaultDataDir: f.candidate
  })
  assert.equal(result.phase, 'selection_required')
  assert.equal(result.source, 'candidate')
  assert.equal(result.dataDir, dataDir)
  assert.equal(result.issue, undefined)
})
