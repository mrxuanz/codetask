import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveAvailablePort } from '../../src/main/port'
import { startAppServer, stopAppServer, type AppServerPlatform } from '../../src/main/server'
import type { DataDirResolution } from '../../src/main/storage-selection'

test('storage setup startup exposes a missing default candidate without creating it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-storage-setup-server-'))
  const candidate = join(root, 'data')
  const storage: DataDirResolution = {
    phase: 'selection_required',
    dataDir: candidate,
    source: 'candidate'
  }
  const platform: AppServerPlatform = {
    isDev: true,
    appRoot: join(root, 'app'),
    resolveDataDirSelection: () => storage,
    persistDataDirSelection: () => undefined
  }
  const available = await resolveAvailablePort('127.0.0.1', 41_000 + (process.pid % 1_000))

  try {
    assert.equal(existsSync(candidate), false)
    const server = await startAppServer(
      {
        mode: 'desktop',
        host: '127.0.0.1',
        port: available.port,
        smokeTest: false
      },
      platform
    )

    const response = await fetch(`${server.url}/api/system/storage/bootstrap`)
    assert.equal(response.ok, true)
    const body = (await response.json()) as {
      data?: { phase?: string; defaultCandidate?: string }
    }
    assert.equal(body.data?.phase, 'selection_required')
    assert.equal(body.data?.defaultCandidate, candidate)
    assert.equal(existsSync(candidate), false)
  } finally {
    await stopAppServer()
    rmSync(root, { recursive: true, force: true })
  }
})
