import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  resolveNodeDataDirSelection,
  resolveNodeDefaultDataDir,
  resolveNodeInitializationConfigPath,
  writeNodeDataInitializationConfig
} from '../../src/standalone/data-dir'

function fixture(t: test.TestContext): {
  root: string
  runtime: { isPackaged: false; developmentRoot: string; executablePath: string }
} {
  const root = mkdtempSync(join(tmpdir(), 'codetask-node-data-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return {
    root,
    runtime: {
      isPackaged: false,
      developmentRoot: root,
      executablePath: join(root, 'ignored')
    }
  }
}

test('standalone Node derives the data directory only from codetask-data dbPath', (t) => {
  const { root, runtime } = fixture(t)
  const dbPath = join(root, 'selected', 'db', 'app.db')
  writeFileSync(
    join(root, 'codetask-data.json'),
    JSON.stringify({
      formatVersion: 1,
      installationId: 'test-installation',
      createdAt: new Date().toISOString(),
      dbPath
    })
  )

  assert.equal(resolveNodeInitializationConfigPath(runtime), join(root, 'codetask-data.json'))
  assert.equal(resolveNodeDefaultDataDir(runtime), join(root, 'selected'))
  assert.deepEqual(resolveNodeDataDirSelection({}, runtime), {
    phase: 'ready',
    dataDir: join(root, 'selected'),
    source: 'config'
  })
})

test('standalone Node creates first-run config without creating the data directory', (t) => {
  const { root, runtime } = fixture(t)
  const configPath = join(root, 'codetask-data.json')
  const selected = join(root, 'selected-data')

  assert.equal(resolveNodeDefaultDataDir(runtime), join(root, 'data'))
  assert.equal(existsSync(join(root, 'data')), false)
  const initial = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  assert.equal(initial.formatVersion, 1)
  assert.equal(typeof initial.installationId, 'string')
  assert.equal(initial.dbPath, '')

  const dbPath = writeNodeDataInitializationConfig(selected, runtime)
  assert.equal(dbPath, join(selected, 'db', 'app.db'))
  const saved = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  assert.equal(saved.installationId, initial.installationId)
  assert.equal(saved.dbPath, dbPath)
})

test('standalone first-run candidate can be injected without another path authority', () => {
  assert.deepEqual(resolveNodeDataDirSelection({ defaultDataDir: '/var/lib/codetask' }), {
    phase: 'selection_required',
    dataDir: '/var/lib/codetask',
    source: 'candidate'
  })
})
