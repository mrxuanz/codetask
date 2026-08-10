import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('shared server composition and standalone adapters do not import Electron', () => {
  const sources = [
    new URL('../../src/main/server.ts', import.meta.url),
    new URL('../../src/standalone/data-dir.ts', import.meta.url),
    new URL('../../src/main/storage-selection.ts', import.meta.url),
    new URL('../../src/standalone/platform.ts', import.meta.url),
    new URL('../../src/standalone/standalone-main.ts', import.meta.url)
  ]

  for (const source of sources) {
    const text = readFileSync(source, 'utf8')
    assert.doesNotMatch(text, /(?:from|import\()\s*['"]electron['"]/u, source.pathname)
    assert.doesNotMatch(text, /@electron-toolkit/u, source.pathname)
  }
})

test('standalone entry forwards the CLI data directory to its platform adapter', () => {
  const source = readFileSync(
    new URL('../../src/standalone/standalone-main.ts', import.meta.url),
    'utf8'
  )
  assert.match(source, /createNodeServerPlatform\(\{ dataDir: cli\.dataDir \}\)/)
  assert.match(source, /cli\.smokeTest && cli\.mode === 'server'/)
})
