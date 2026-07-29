import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  resolveNodeBootstrapRoot,
  resolveNodeDataDirSelection,
  resolveNodeDefaultDataDir,
  resolveNodeInitializationConfigPath
} from '../../src/standalone/data-dir'

test('standalone Node bootstrap path is deterministic and ignores environment configuration', () => {
  const runtime = {
    platform: 'linux' as const,
    homeDir: '/home/codetask'
  }

  assert.equal(resolveNodeBootstrapRoot(runtime), join('/home/codetask', '.config', 'codetask'))
})

test('standalone Node reads development dbPath from the project-root config', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-node-data-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'codetask-data.json'), JSON.stringify({ dbPath: './data' }))

  const runtime = {
    isPackaged: false,
    developmentRoot: root,
    executablePath: join(root, 'ignored')
  }
  assert.equal(resolveNodeInitializationConfigPath(runtime), join(root, 'codetask-data.json'))
  assert.equal(resolveNodeDefaultDataDir(runtime), join(root, 'data'))
})

test('explicit standalone data directory keeps the shared storage contract', () => {
  const result = resolveNodeDataDirSelection({
    explicitDataDir: '/var/lib/codetask',
    mode: 'server',
    bootstrapRoot: '/etc/codetask',
    defaultDataDir: '/unused'
  })

  assert.equal(result.phase, 'ready')
  assert.equal(result.source, 'cli')
  assert.equal(result.dataDir, '/var/lib/codetask')
  assert.equal(result.bootstrap.root, '/etc/codetask')
})
