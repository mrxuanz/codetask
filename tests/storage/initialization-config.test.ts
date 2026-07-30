import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import {
  INITIALIZATION_CONFIG_FILENAME,
  ensureInitializationConfig,
  readInitializationConfig,
  resolveInitializationConfigPath,
  resolveInitializationDefaultDataDir,
  writeInitializationConfig
} from '../../src/main/initialization-config'

function fixture(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'codetask-initialization-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('development config is resolved from the project root', () => {
  const projectRoot = resolve('workspace', 'codetask')
  const result = resolveInitializationConfigPath({
    isPackaged: false,
    executablePath: resolve('ignored', 'codetask'),
    developmentRoot: projectRoot
  })

  assert.equal(result, join(projectRoot, INITIALIZATION_CONFIG_FILENAME))
})

test('packaged config is resolved beside the executable', () => {
  const executablePath = resolve('dist', 'codetask', 'codetask.exe')
  const result = resolveInitializationConfigPath({
    isPackaged: true,
    executablePath,
    developmentRoot: resolve('ignored')
  })

  assert.equal(result, join(dirname(executablePath), INITIALIZATION_CONFIG_FILENAME))
  assert.equal(resolveInitializationDefaultDataDir(result), join(dirname(executablePath), 'data'))
})

test('relative dbPath is resolved from codetask-data.json', (t) => {
  const root = fixture(t)
  const configPath = join(root, INITIALIZATION_CONFIG_FILENAME)
  writeFileSync(configPath, JSON.stringify({ dbPath: './runtime-data' }), 'utf8')

  assert.equal(readInitializationConfig(configPath).dbPath, join(root, 'runtime-data'))
})

test('absolute dbPath is preserved as an absolute normalized path', (t) => {
  const root = fixture(t)
  const dataRoot = join(root, 'data-root')
  const configPath = join(root, INITIALIZATION_CONFIG_FILENAME)
  writeFileSync(configPath, JSON.stringify({ dbPath: dataRoot }), 'utf8')

  assert.equal(readInitializationConfig(configPath).dbPath, resolve(dataRoot))
})

test('missing config is created with installation identity and an empty dbPath', (t) => {
  const root = fixture(t)
  const configPath = join(root, INITIALIZATION_CONFIG_FILENAME)

  const config = ensureInitializationConfig(configPath)
  assert.equal(config.formatVersion, 1)
  assert.match(config.installationId, /^[0-9a-f-]{36}$/)
  assert.ok(Date.parse(config.createdAt) > 0)
  assert.equal(config.dbPath, '')
  assert.equal(existsSync(configPath), true)
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), config)
  assert.equal(resolveInitializationDefaultDataDir(configPath), join(root, 'data'))
})

test('empty dbPath is valid until the user selects a storage folder', (t) => {
  const root = fixture(t)
  const configPath = join(root, INITIALIZATION_CONFIG_FILENAME)
  writeFileSync(configPath, JSON.stringify({ dbPath: '  ' }), 'utf8')

  assert.equal(readInitializationConfig(configPath).dbPath, '')
})

test('invalid dbPath still fails with a useful initialization error', (t) => {
  const root = fixture(t)
  const configPath = join(root, INITIALIZATION_CONFIG_FILENAME)
  writeFileSync(configPath, JSON.stringify({}), 'utf8')

  assert.throws(() => readInitializationConfig(configPath), /dbPath must be a string/)
})

test('selected SQLite path is persisted while installation identity remains stable', (t) => {
  const root = fixture(t)
  const configPath = join(root, INITIALIZATION_CONFIG_FILENAME)
  const selectedDb = join(root, 'selected-data', 'db', 'app.db')
  const initial = ensureInitializationConfig(configPath)

  const saved = writeInitializationConfig(configPath, selectedDb)
  assert.equal(saved.dbPath, resolve(selectedDb))
  assert.equal(saved.installationId, initial.installationId)
  assert.equal(saved.createdAt, initial.createdAt)
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), saved)
})

test('legacy data-root marker is merged into codetask-data.json and removed', (t) => {
  const root = fixture(t)
  const dataRoot = join(root, 'legacy-data')
  const configPath = join(root, INITIALIZATION_CONFIG_FILENAME)
  const createdAt = '2026-01-02T03:04:05.000Z'
  mkdirSync(dataRoot)
  writeFileSync(configPath, JSON.stringify({ dbPath: dataRoot }), 'utf8')
  writeFileSync(
    join(dataRoot, '.codetask-data.json'),
    JSON.stringify({
      formatVersion: 1,
      installationId: 'legacy-installation',
      createdAt
    }),
    { encoding: 'utf8', flag: 'wx' }
  )

  const merged = ensureInitializationConfig(configPath)
  assert.equal(merged.installationId, 'legacy-installation')
  assert.equal(merged.createdAt, createdAt)
  assert.equal(merged.dbPath, join(dataRoot, 'db', 'app.db'))
  assert.equal(existsSync(join(dataRoot, '.codetask-data.json')), false)
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), merged)
})
