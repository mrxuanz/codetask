import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { bootstrapRuntime, resetAppContextForTests } from '../../src/server/bootstrap'
import { seedMinimalJob } from '../helpers/seed-minimal-job'
import { getStorageMigration, startStorageMigration } from '../../src/server/storage/migration'
import { endDraining } from '../../src/server/legacy-control-plane/shutdown-state'
import {
  StorageLocatorRepository,
  bootstrapPaths,
  createStorageLocator,
  writeDataRootMarker
} from '../../src/main/storage-locator'
import { writeCredentialSnapshotManifest } from '../../src/server/sandbox/provider-auth/snapshot-manifest'

test('storage migration checkpoints, copies, verifies, scrubs credentials, and switches locator', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-storage-migration-'))
  t.after(async () => {
    await resetAppContextForTests()
    endDraining()
    rmSync(root, { recursive: true, force: true })
  })
  const oldDataDir = join(root, 'old-data')
  const targetDataDir = join(root, 'new-data')
  const bootstrap = bootstrapPaths(join(root, 'bootstrap-root'))
  const marker = writeDataRootMarker(oldDataDir)
  new StorageLocatorRepository(bootstrap).write(
    createStorageLocator({
      dataDir: oldDataDir,
      source: 'desktop_setup',
      installationId: marker.installationId
    })
  )
  mkdirSync(targetDataDir)

  const ctx = bootstrapRuntime({
    dataDir: oldDataDir,
    authSecretPath: bootstrap.authSecretFile,
    storage: { bootstrapRoot: bootstrap.root, source: 'locator', managed: false }
  })
  await seedMinimalJob(ctx.db, 'job-storage-migration', 'completed')

  const runtime = join(oldDataDir, 'runtimes', 'thread-1', 'jobs', 'job-1', 'codex')
  const authPath = join(runtime, '.codex', 'auth.json')
  const sessionPath = join(runtime, '.codex', 'sessions', 'keep.json')
  mkdirSync(join(runtime, '.codex', 'sessions'), { recursive: true })
  writeFileSync(authPath, '{"token":"secret"}')
  writeFileSync(sessionPath, '{"session":true}')
  writeCredentialSnapshotManifest(runtime, 'codex', [authPath])
  mkdirSync(join(oldDataDir, 'config'), { recursive: true })
  writeFileSync(
    join(oldDataDir, 'config', 'settings.json'),
    '{"retention":{"workingArtifactDays":1}}'
  )
  mkdirSync(join(oldDataDir, 'blobs', 'artifacts', 'designs', 'old-design'), {
    recursive: true
  })
  writeFileSync(
    join(oldDataDir, 'blobs', 'artifacts', 'designs', 'old-design', 'plan-v1.json.gz'),
    'old'
  )

  const started = startStorageMigration(ctx, targetDataDir)
  let current = getStorageMigration(ctx, started.migrationId)
  const deadline = Date.now() + 10_000
  while (
    current &&
    !['restart_required', 'failed'].includes(current.phase) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    current = getStorageMigration(ctx, started.migrationId)
  }

  assert.equal(current?.phase, 'restart_required', current?.error)
  assert.equal(existsSync(join(targetDataDir, 'db', 'app.db')), true)
  assert.equal(existsSync(join(targetDataDir, 'config', 'settings.json')), false)
  assert.equal(existsSync(join(targetDataDir, 'blobs', 'artifacts', 'designs')), false)
  assert.equal(
    existsSync(
      join(targetDataDir, 'runtimes', 'thread-1', 'jobs', 'job-1', 'codex', '.codex', 'auth.json')
    ),
    false
  )
  assert.equal(
    readFileSync(
      join(
        targetDataDir,
        'runtimes',
        'thread-1',
        'jobs',
        'job-1',
        'codex',
        '.codex',
        'sessions',
        'keep.json'
      ),
      'utf8'
    ),
    '{"session":true}'
  )
  const locator = new StorageLocatorRepository(bootstrap).read()
  assert.equal(locator.status, 'valid')
  if (locator.status === 'valid') {
    assert.equal(realpathSync.native(locator.locator.dataDir), realpathSync.native(targetDataDir))
  }
  assert.equal(existsSync(oldDataDir), true)
})
