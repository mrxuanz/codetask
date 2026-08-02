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
  assert.equal(store.readNamespace('agent_defaults').revision, 0)
  assert.equal(existsSync(oldSettingsPath), true)
})

test('settings namespaces use independent CAS revisions', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-settings-revision-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const db = createIsolatedTestDatabase(dataDir)
  t.after(() => closeIsolatedTestDatabase(db))
  const store = new SettingsStore(dataDir, db)

  assert.equal(
    store.writeNamespace('agent_prompts', { conversation: { mode: 'default', body: '' } }, {
      expectedRevision: 0
    }),
    1
  )
  assert.equal(
    store.writeNamespace('agent_defaults', { plannerProvider: 'codex' }, { expectedRevision: 0 }),
    1
  )
  assert.equal(
    store.writeNamespace('agent_prompts', { conversation: { mode: 'custom', body: 'x' } }, {
      expectedRevision: 1
    }),
    2
  )
  assert.throws(
    () =>
      store.writeNamespace('agent_prompts', { conversation: { mode: 'custom', body: 'y' } }, {
        expectedRevision: 1
      }),
    SettingsRevisionConflictError
  )
  assert.deepEqual(store.readNamespace('agent_prompts').value, {
    conversation: { mode: 'custom', body: 'x' }
  })
})
