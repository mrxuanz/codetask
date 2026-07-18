import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import {
  resolveNodeBootstrapRoot,
  resolveNodeDataDirSelection,
  resolveNodeDefaultDataDir
} from '../../src/standalone/data-dir'

test('standalone Node paths follow XDG conventions without Electron', () => {
  const runtime = {
    platform: 'linux' as const,
    homeDir: '/home/codetask',
    env: {
      XDG_CONFIG_HOME: '/srv/config',
      XDG_DATA_HOME: '/srv/data'
    }
  }

  assert.equal(resolveNodeBootstrapRoot(runtime), join('/srv/config', 'codetask'))
  assert.equal(resolveNodeDefaultDataDir(runtime), join('/srv/data', 'codetask'))
})

test('explicit standalone data directory keeps the shared storage contract', () => {
  const result = resolveNodeDataDirSelection(
    {
      explicitDataDir: '/var/lib/codetask',
      mode: 'server',
      bootstrapRoot: '/etc/codetask',
      defaultDataDir: '/unused'
    },
    { env: {} }
  )

  assert.equal(result.phase, 'ready')
  assert.equal(result.source, 'cli')
  assert.equal(result.dataDir, '/var/lib/codetask')
  assert.equal(result.bootstrap.root, '/etc/codetask')
})
