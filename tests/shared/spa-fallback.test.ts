import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSetupShell } from '../../src/main/setup-shell'
import { bootstrapPaths } from '../../src/main/storage-locator'
import { shouldServeSpaIndex } from '../../src/server/http/spa-fallback'

test('SPA fallback accepts page navigation but rejects asset and API-style requests', () => {
  assert.equal(
    shouldServeSpaIndex(
      new Request('http://localhost/home/tasks/job-123', {
        headers: { accept: 'text/html,application/xhtml+xml' }
      }),
      '/home/tasks/job-123'
    ),
    true
  )
  assert.equal(
    shouldServeSpaIndex(
      new Request('http://localhost/home/tasks/assets/missing.js', {
        headers: { accept: '*/*' }
      }),
      '/home/tasks/assets/missing.js'
    ),
    false
  )
  assert.equal(
    shouldServeSpaIndex(
      new Request('http://localhost/home/tasks/job-123', {
        headers: { accept: 'application/json' }
      }),
      '/home/tasks/job-123'
    ),
    false
  )
  assert.equal(
    shouldServeSpaIndex(
      new Request('http://localhost/home/tasks/job-123', {
        method: 'POST',
        headers: { accept: 'text/html' }
      }),
      '/home/tasks/job-123'
    ),
    false
  )
})

test('production setup shell serves deep links and leaves missing assets as 404', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-spa-fallback-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const staticDir = join(root, 'renderer')
  mkdirSync(join(staticDir, 'assets'), { recursive: true })
  writeFileSync(join(staticDir, 'index.html'), '<div id="app">spa-entry</div>')
  writeFileSync(join(staticDir, 'assets', 'app.js'), 'globalThis.__spaLoaded = true')

  const app = createSetupShell({
    storage: {
      phase: 'selection_required',
      dataDir: join(root, 'data'),
      source: 'candidate',
      managed: false,
      bootstrap: bootstrapPaths(join(root, 'bootstrap'))
    },
    isDev: false,
    staticDir
  })

  const deepLink = await app.request('/home/tasks/job-123', {
    headers: { accept: 'text/html' }
  })
  assert.equal(deepLink.status, 200)
  assert.match(await deepLink.text(), /spa-entry/)

  const asset = await app.request('/assets/app.js')
  assert.equal(asset.status, 200)
  assert.match(await asset.text(), /__spaLoaded/)

  const missingAsset = await app.request('/home/tasks/assets/missing.js')
  assert.equal(missingAsset.status, 404)
  assert.match(missingAsset.headers.get('content-type') ?? '', /application\/json/)
})
