import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  SettingsRevisionConflictError,
  SettingsStore
} from '../../src/server/context/settings-store'
import { closeIsolatedTestDatabase, createIsolatedTestDatabase } from '../../src/server/db'

test('settings.json is ignored because SQLite is the only settings authority', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-settings-no-import-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const oldSettingsPath = join(dataDir, 'config', 'settings.json')
  mkdirSync(dirname(oldSettingsPath), { recursive: true })
  writeFileSync(
    oldSettingsPath,
    JSON.stringify({
      controlPlane: { plannerCoreCode: 'codex' },
      retention: { workingArtifactDays: 9 },
      prompts: { planner: { body: 'test', useDefault: false } }
    })
  )
  const db = createIsolatedTestDatabase(dataDir)
  t.after(() => closeIsolatedTestDatabase(db))

  const store = new SettingsStore(dataDir, db)
  assert.deepEqual(store.read(), {})
  assert.equal(existsSync(oldSettingsPath), true)
})

test('settings namespaces use independent CAS revisions', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-settings-revision-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const db = createIsolatedTestDatabase(dataDir)
  t.after(() => closeIsolatedTestDatabase(db))
  const store = new SettingsStore(dataDir, db)

  assert.equal(
    store.writeNamespace('retention', { workingArtifactDays: 14 }, { expectedRevision: 0 }),
    1
  )
  assert.equal(store.writeNamespace('prompts', { planner: {} }, { expectedRevision: 0 }), 1)
  assert.equal(
    store.writeNamespace('retention', { workingArtifactDays: 7 }, { expectedRevision: 1 }),
    2
  )
  assert.throws(
    () => store.writeNamespace('retention', { workingArtifactDays: 1 }, { expectedRevision: 1 }),
    SettingsRevisionConflictError
  )
  assert.deepEqual(store.readNamespace('retention').value, { workingArtifactDays: 7 })
  assert.deepEqual(store.readNamespace('prompts').value, { planner: {} })
})

test('patch updates only the changed namespace revision', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-settings-patch-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const db = createIsolatedTestDatabase(dataDir)
  t.after(() => closeIsolatedTestDatabase(db))
  const store = new SettingsStore(dataDir, db)
  store.writeNamespace('prompts', { planner: 'before' })
  store.writeNamespace('retention', { workingArtifactDays: 14 })

  store.patch((settings) => {
    settings.prompts = { planner: 'after' }
  })

  assert.equal(store.readNamespace('prompts').revision, 2)
  assert.equal(store.readNamespace('retention').revision, 1)
})
