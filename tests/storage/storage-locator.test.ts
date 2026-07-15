import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

test('headless server requires an operator-managed data directory', (t) => {
  const f = fixture(t)
  const result = resolveStorageLocation({
    mode: 'server',
    bootstrapRoot: f.bootstrapRoot,
    defaultDataDir: f.candidate
  })
  assert.equal(result.phase, 'recovery_required')
  assert.equal(result.issue, 'server_data_dir_required')
})
