import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  clearPublishedRunningService,
  discoverRunningService,
  publishRunningService
} from '../../src/main/service-discovery'
import { bootstrapPaths } from '../../src/main/storage-locator'

test('desktop discovers a healthy service for the same data directory', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-service-discovery-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const paths = bootstrapPaths(join(root, 'bootstrap-root'))
  const dataDir = join(root, 'data')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ success: true, data: { status: 'ok' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const port = 43210

  publishRunningService(
    paths,
    {
      host: '127.0.0.1',
      port,
      url: `http://127.0.0.1:${port}`,
      requestedPort: 8080,
      portChanged: true,
      mode: 'server'
    },
    dataDir
  )
  t.after(() => clearPublishedRunningService())

  const discovered = await discoverRunningService(paths, dataDir)
  assert.equal(discovered?.url, `http://127.0.0.1:${port}`)
  assert.equal(await discoverRunningService(paths, join(root, 'other-data')), null)

  clearPublishedRunningService()
  assert.equal(existsSync(paths.serviceDiscoveryFile), false)
})
