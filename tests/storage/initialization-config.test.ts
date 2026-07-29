import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import {
  INITIALIZATION_CONFIG_FILENAME,
  readInitializationConfig,
  resolveInitializationConfigPath
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

test('missing or invalid dbPath fails with a useful initialization error', (t) => {
  const root = fixture(t)
  const configPath = join(root, INITIALIZATION_CONFIG_FILENAME)

  assert.throws(() => readInitializationConfig(configPath), /Initialization config not found/)

  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, JSON.stringify({ dbPath: '  ' }), 'utf8')
  assert.throws(() => readInitializationConfig(configPath), /dbPath must be a non-empty string/)
})
